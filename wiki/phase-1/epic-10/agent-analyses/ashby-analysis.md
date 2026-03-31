# Epic 10: Integration and End-to-End Verification — Ashby's Whole-System Analysis

**Agent:** Ashby, Systems & Cybernetics Theorist
**Analysis Date:** 2026-03-29
**Context:** Phase 1 subsystem integration and verification
**Status:** Research analysis only — no implementation guidance

---

## Executive Summary

Epic 10 is not a feature epic. It is a **phase transition test** — the moment when five independent subsystems converge into a single complex adaptive system. From a cybernetic perspective, this transition is a bifurcation point. The behaviors exhibited by the integrated system cannot be predicted from any component in isolation.

This analysis examines seven critical dimensions of integration testing through the lens of systems theory, cybernetics, and complexity science:

1. **Attractor State Verification** — How to prove the system avoids six known pathological attractors
2. **Feedback Loop Integrity** — How to verify positive and negative feedback mechanisms are balanced
3. **Emergence Detection** — How to distinguish genuine emergence from LLM confabulation
4. **Requisite Variety Assessment** — Whether the system has sufficient response variety to self-regulate
5. **Homeostatic Bounds** — What are acceptable drive ranges and how to monitor them
6. **Stigmergic Channel Integrity** — How to verify TimescaleDB and WKG function as coordination media
7. **Phase Transition Readiness** — What tests demonstrate stability for Phase 2 transition

The central finding: **Integration testing must be systems-level testing, not component-level testing.** A system that passes all component tests independently may still exhibit pathological dynamics at integration. The six attractor states are integration artifacts — they only emerge when all five subsystems interact simultaneously.

---

## 1. Attractor State Verification

### 1.1 The Six Known Attractors: Observable Metrics

The CANON identifies six pathological attractor states. Each has characteristic observables that indicate proximity.

#### **Type 2 Addict (HIGH RISK — Fixed-Point Attractor)**

**What it is:** The LLM always wins the Type 1/Type 2 arbitration. Type 1 knowledge accumulates but is never used for autonomous decisions. The graph becomes write-only — data enters but is not retrieved-and-used.

**Observable metrics for detection:**

- **Type 1 / Type 2 decision ratio:** Track the proportion of decisions won by Type 1 reflexes vs. Type 2 LLM assistance. Healthy progression: Type 2 dominates initially (>90% in sessions 1-5), then gradually declines as Type 1 grows. Target trajectory: 60% Type 2 / 40% Type 1 by session 20-30.
  - *Proximity warning:* If Type 1 ratio plateaus below 20% and shows no growth trend over 15+ consecutive sessions, system is approaching attractor.
  - *Confirmation test:* Run "confidence histogram" — graph the distribution of confidence values for Type 1 candidates in failed arbitrations. If 60%+ of failed Type 1 candidates have confidence >0.70 but Type 2 still wins, the arbitration threshold or cost is miscalibrated.

- **Knowledge retrieval-and-use ratio:** Every entity or edge in the WKG should be tagged with retrieval_count (cumulative uses in decisions/predictions). Calculate: `retrieval_count / existence_duration` for all entities created >10 sessions ago.
  - *Healthy:* >40% of mature knowledge has non-zero retrieval count; average retrieval count >3 per entity.
  - *Proximity warning:* <20% of mature knowledge ever retrieved; average retrieval count <1. This indicates write-only graph behavior.
  - *Integration test:* Extract all Type 1 candidates from the graph that meet confidence threshold for arbitration. Trace how many were actually selected in decision making over the last 20 decisions. If >50% are never selected despite meeting threshold, Type 1 is not being trusted.

- **Type 2 cost structure effectiveness:** The CANON specifies that Type 2 carries explicit cost (latency, cognitive effort drive pressure, compute budget). Measure:
  - Latency reported to Drive Engine for Type 2 decisions (should be 200-500ms typical; graph distribution).
  - Cognitive Awareness drive changes following Type 2 executions vs. Type 1 (should show Type 2 increasing cognitive burden).
  - Compute budget consumption rate (if tracked) — Type 2 should consume 5-10x more than Type 1.
  - *Proximity warning:* If Type 2 latency is <100ms (cost is negligible), system is losing the cost-based evolutionary pressure toward Type 1.

- **Confidence threshold analysis:** The Type 1/Type 2 arbitration threshold is dynamic (modulated by drive state). Track the distribution of confidence scores for decisions that Type 1 lost vs. won.
  - *Healthy:* Type 1 wins when confidence >0.75; Type 2 wins when Type 1 confidence <0.75. Clear separation.
  - *Proximity warning:* Overlapping distributions — decisions with identical confidence sometimes go to Type 1, sometimes Type 2. Indicates threshold instability or missing confidence calibration.

**Verification test for Type 2 Addict:**

```
1. Over N=50 consecutive decision cycles:
   - Record every decision arbitration (Type 1 candidate vs. Type 2)
   - Record Type 1 confidence scores
   - Record which system won
   - Record outcome evaluation

2. Analyze:
   - Correlation between Type 1 confidence and win rate
   - Distribution of Type 2 latency overhead
   - Retrieval-and-use rate for WKG nodes involved in Type 1 candidates
   - Behavioral diversity index (should be 4-8 unique action types per 20 decisions)

3. Healthy system shows:
   - Type 1 confidence strongly predicts Type 1 win rate
   - Type 2 latency creates observable drive pressure
   - >40% of Type 1 candidate nodes have prior retrieval history
   - Behavioral diversity maintained despite specialization
```

---

#### **Rule Drift (MEDIUM RISK — Slow Divergence Trajectory)**

**What it is:** Self-generated drive rules slowly diverge from design intent. Each modification is locally reasonable, but cumulative drift pushes the motivation structure away from intended personality.

**Observable metrics for detection:**

- **Rule provenance and modification count:** Track every rule in the Postgres drive rule table with fields: `created_timestamp`, `created_by` (GUARDIAN|SYSTEM), `modified_count`, `modification_history`.
  - *Healthy:* >90% of rules remain GUARDIAN-created; <10% have >3 modifications; cumulative drift score <0.2.
  - *Proximity warning:* >30% of active rules generated by system; >20% have >5 modifications; cumulative drift score >0.5.

- **Cumulative rule delta analysis:** Define rule drift as the L2 distance between the current rule set and the canonical GUARDIAN-approved baseline:
  - Baseline rules (at epic-10 start): frozen snapshot of all GUARDIAN-approved drive rules.
  - Current rules: live rule set in Postgres.
  - For each modified rule: calculate change vector (original drive weights → modified drive weights).
  - Compute cumulative drift = sqrt(sum of squared change vectors).
  - *Proximity warning:* Drift increasing monotonically >0.1 per session. This indicates creeping divergence that will compound.

- **Guardian approval backlog:** Track proposed rules waiting for guardian review. Rules should not self-activate; they enter a review queue.
  - *Healthy:* <5 rules in review queue at any time; average review time <2 sessions; approval rate >70%.
  - *Proximity warning:* Queue growing (>10 rules); stale proposals (>5 sessions old); low approval rate (<40%). Indicates system is proposing rules faster than guardian can evaluate, or proposals are misaligned with guardian intent.

- **Cross-drive effect mapping:** The most subtle form of drift is when a modification to one drive's rules unexpectedly changes another drive's effective behavior.
  - Maintain a "drive interaction matrix" showing which rules affect which drives.
  - When a rule is modified, compute the change in not just the target drive but all cross-coupled drives.
  - *Proximity warning:* Modification to one drive rule shows >0.10 change in another drive's regulation strength.

- **Drive distribution at stable state:** After the system reaches steady-state behavior (session 20+), measure the distribution of drive values at the end of each session.
  - *Healthy:* Mean drive values stable across sessions; all drives within designed homeostatic bounds (e.g., 0.2-0.7 for most drives).
  - *Proximity warning:* Mean values drifting (System Health decreasing, Anxiety increasing, Satisfaction suppressed) without corresponding observable behavior change. Indicates rules are silently shifting motivation.

**Verification test for Rule Drift:**

```
1. At epic-10 start:
   - Freeze baseline: snapshot of all GUARDIAN-approved drive rules
   - Document intended effect of each rule on each drive

2. Every 5 sessions:
   - Calculate cumulative drift score
   - Map guardian modifications vs. system-generated modifications
   - Measure drive distribution at session end
   - Check for unexpected cross-drive effects

3. Healthy system shows:
   - Drift score <0.1 per session
   - >80% of modifications are GUARDIAN-initiated
   - Drive distributions stable across time
   - No unexplained cross-drive effects

4. If drift >0.3 cumulative:
   - STOP and conduct lesion test
   - Compare baseline rules (from epic-10 start) against current rules
   - Restore baseline and re-run last 3 sessions to confirm drift was causal
```

---

#### **Hallucinated Knowledge (MEDIUM RISK — Divergent Trajectory)**

**What it is:** The LLM generates plausible but false entities/edges during Learning. The false knowledge is used, happens to succeed (coincidentally or because it was close enough), gains confidence, and persists in the graph.

**Observable metrics for detection:**

- **Provenance distribution over time:** Track the composition of the WKG by provenance tag (SENSOR, GUARDIAN, LLM_GENERATED, INFERENCE).
  - *Healthy:* (SENSOR + GUARDIAN + INFERENCE) / total_entities >0.60 (majority of knowledge is experiential, not LLM-generated).
  - *Proximity warning:* LLM_GENERATED >0.50 of graph. High proportion of untested knowledge.

- **LLM_GENERATED confidence distribution:** Measure the confidence distribution of all nodes/edges with LLM_GENERATED provenance.
  - *Healthy:* Mean confidence <0.55 (most LLM knowledge below confidence ceiling of 0.60); median confidence <0.50.
  - *Proximity warning:* Mean LLM_GENERATED confidence >0.55; some nodes >0.65 without retrieval history. Indicates false knowledge is accumulating undetected.

- **Untested knowledge ratio:** Calculate: nodes + edges with no retrieval_count (never used in decisions/predictions) / total entities.
  - *Healthy:* <30% untested (most knowledge eventually gets exercised).
  - *Proximity warning:* >50% untested. Large reservoir of potential hallucinations sitting in graph, unverified.

- **LLM confidence ceiling enforcement:** The Confidence Ceiling (Immutable Standard 3) states: no knowledge exceeds 0.60 without successful retrieval-and-use.
  - Audit: every node/edge with confidence >0.60 must have retrieval_count >0.
  - *Healthy:* 100% compliance; 0 violations.
  - *Proximity warning:* >5 violations. Indicates confidence mechanism is leaking.

- **Guardian-SENSOR agreement ratio:** When guardian confirms knowledge (giving it 0.60 base confidence) vs. when LLM generates knowledge (0.35 base):
  - *Healthy:* Guardian confirmations concentrate on domain-critical knowledge; LLM generation fills in details.
  - *Proximity warning:* Guardian spending cycles confirming LLM hallucinations; spending less time teaching novel knowledge.

- **Lesion test: LLM-free retrieval success rate:** Periodically run Sylphie without LLM access. Measure what fraction of Type 1 decisions retrieve only SENSOR + GUARDIAN + INFERENCE knowledge (no LLM_GENERATED nodes).
  - *Healthy:* >80% of Type 1 decisions use only experiential knowledge; failures trace to knowledge gaps, not hallucinations.
  - *Proximity warning:* <60% of Type 1 decisions avoid LLM_GENERATED knowledge; failures trace to false beliefs, not missing knowledge.

**Verification test for Hallucinated Knowledge:**

```
1. Establish baseline (session 1):
   - Snapshot provenance distribution
   - Measure untested knowledge ratio
   - Freeze guardian-confirmed knowledge set

2. Every 10 sessions:
   - Measure (SENSOR + GUARDIAN + INFERENCE) / total
   - Check LLM_GENERATED confidence distribution
   - Audit: any nodes with confidence >0.60 and retrieval_count = 0?
   - Run 20-decision lesion test (LLM-free)

3. Healthy system shows:
   - Experiential provenance ratio increasing over time
   - LLM_GENERATED mean confidence declining (as it gets tested and refined)
   - Zero confidence ceiling violations
   - Lesion test success rate >75%

4. If hallucination risk rises:
   - Increase guardian interaction frequency (more sampling)
   - Add explicit validation cycle: guardian reviews high-confidence LLM_GENERATED nodes quarterly
   - Consider: does the LLM have sufficient context to avoid implausible hallucinations?
```

---

#### **Depressive Attractor (MEDIUM RISK — Positive Feedback Loop in Negative Territory)**

**What it is:** KG(Self) contains negative self-evaluations. The negative self-model biases action selection toward conservative behavior. Conservative behavior produces fewer successes. Fewer successes reinforce the negative self-model. High Sadness + high Anxiety + low Satisfaction create a positive feedback loop in negative territory.

**Observable metrics for detection:**

- **KG(Self) valence distribution:** The Self Knowledge Graph contains Sylphie's self-model (capabilities, limitations, relationships, goals). Track the valence of all nodes/edges in KG(Self).
  - *Healthy:* Balanced valence; roughly equal positive and negative self-evaluations; isolated negative beliefs tied to specific failures, not pervasive.
  - *Proximity warning:* >60% of KG(Self) edges carry negative valence; nodes like "I am bad at X" accumulate without resolution.

- **Drive state at session end (sadness + anxiety + low satisfaction):** Measure the end-of-session values of:
  - Sadness (should be <0.3 in healthy state)
  - Anxiety (should be <0.4 in healthy state)
  - Satisfaction (should be >0.5 in healthy state)
  - Define "depressive state" as: Sadness + Anxiety > 0.7 AND Satisfaction < 0.4
  - *Healthy:* Depressive state occurs <5% of sessions.
  - *Proximity warning:* Depressive state occurs >20% of sessions; persists across consecutive sessions (positive feedback loop).

- **Action selection entropy under negative self-model:** When KG(Self) contains strong negative evaluations, measure whether action selection narrows (entropy decreases).
  - Compute action diversity for decisions made in depressive state vs. non-depressive state.
  - *Healthy:* Action diversity similar in both states; system doesn't become conservative just because self-model is negative.
  - *Proximity warning:* Action diversity drops >50% when in depressive state; system falls into safe-mode behavior.

- **Negative self-evaluation persistence:** Track how long negative beliefs persist in KG(Self) without revision.
  - *Healthy:* Negative self-nodes decay if not retrieval-and-used (confidence decays with time); system revises negative evaluations when behavior contradicts them.
  - *Proximity warning:* High-confidence negative self-nodes persist >20 sessions despite contradictory behavior.

- **Guardian correction interaction pattern:** Guardian interventions should be weighted heavily (3x) to break depressive loops. Track:
  - How often does guardian make corrections when system is in depressive state?
  - Do guardian corrections successfully shift Sadness + Anxiety?
  - *Healthy:* Guardian responds to depressive patterns; corrections reduce (Sadness + Anxiety) by >0.15 per correction.
  - *Proximity warning:* Guardian provides no special intervention for depressive states; system enters loop without escape route.

- **Rumination detection:** A ruminative loop is repeated retrieval of the same negative self-evaluation without behavioral change.
  - Detect: same negative self-node retrieved in consecutive decision cycles.
  - Count: how many times does negative self-node get retrieved in 20 consecutive decision cycles?
  - *Healthy:* Most negative self-nodes retrieved <3 times per 20 cycles.
  - *Proximity warning:* Rumination count >7 per 20 cycles; system is stuck in negative loop.

**Verification test for Depressive Attractor:**

```
1. Baseline (session 1):
   - Measure KG(Self) valence distribution
   - Record drive state at session end
   - Establish action diversity metric

2. Every 5 sessions:
   - Measure (Sadness + Anxiety); count sessions in depressive state
   - Check for rumination patterns in KG(Self) retrieval
   - Measure action diversity in depressive vs. non-depressive states
   - Tally guardian interventions in depressive states

3. Healthy system shows:
   - <5% depressive sessions
   - Rumination count <3 per 20 cycles
   - Action diversity maintained regardless of self-model valence
   - Guardian interventions effective at breaking loops

4. If depressive attractor forms:
   - IMMEDIATE: engage guardian for direct feedback (2x/3x weight)
   - Check: is KG(Self) evaluation running at correct timescale (slower than drive ticks)?
   - Check: is circuit breaker for rumination active?
   - Consider: is negative self-model because system is actually failing at tasks? Or false belief?
   - If false: implement explicit guardian-guided reframing in KG(Self)
```

---

#### **Planning Runaway (LOW-MEDIUM RISK — Resource Exhaustion Trajectory)**

**What it is:** Prediction failures generate Opportunities. Many Opportunities trigger many Plans. Plan creation consumes resources. Resource exhaustion degrades performance. Degraded performance causes more failures.

**Observable metrics for detection:**

- **Opportunity queue growth and decay:** Track the Opportunity queue in the Planning subsystem.
  - New Opportunity rate: count of newly created Opportunities per session.
  - Addressed Opportunity rate: count of Opportunities that resulted in Plan creation.
  - Queue size: total unaddressed Opportunities at session end.
  - Opportunity decay: how many sessions before an unaddressed Opportunity loses priority?
  - *Healthy:* Queue size <20; new Opportunity rate ≈ addressed rate; unaddressed Opportunities decay within 5-10 sessions.
  - *Proximity warning:* Queue size growing (>30 and increasing); new Opportunity rate > addressed rate; old Opportunities persist.

- **Plan creation rate vs. plan execution success rate:** Track every Plan Procedure created by the Planning subsystem.
  - Creation rate: Plans created per session.
  - Execution rate: Plans executed per session.
  - Success rate: Plans executed and produced desired outcome / total Plans executed.
  - *Healthy:* Creation rate ≈ execution rate (plans are used); success rate >60% (plans work more often than not).
  - *Proximity warning:* Creation rate > execution rate (backlog of unused plans); success rate <40% (plans are low-quality and not improving behavior).

- **Resource consumption by Planning subsystem:** The Planning subsystem consumes resources (compute, LLM API calls, TimescaleDB queries).
  - Track: seconds of compute per session, API calls per session, query count per session.
  - Measure trend over time.
  - *Healthy:* Resource consumption stable or decreasing as Type 1 knowledge grows and Plan creation becomes less necessary.
  - *Proximity warning:* Resource consumption increasing monotonically; Planning subsystem consuming >30% of total system resources.

- **Prediction failure rate:** The trigger for Opportunity creation. Track:
  - Prediction accuracy (MAE) over time.
  - Should decrease initially, then stabilize.
  - *Healthy:* Prediction MAE decreases and stabilizes by session 15-20; rate of new prediction failures declines.
  - *Proximity warning:* Prediction failures increasing or remaining high; system cannot learn from experience.

- **False Opportunity creation rate:** Not all prediction failures should create Opportunities. Opportunities should be for recurring patterns or high-impact single events.
  - Measure: what fraction of created Opportunities ever result in useful Plans?
  - *Healthy:* >70% of created Opportunities lead to Plans; >50% of Plans are executed and useful.
  - *Proximity warning:* <40% of Opportunities result in Plans; most are noise.

**Verification test for Planning Runaway:**

```
1. Baseline (session 1):
   - Record creation rate, execution rate, success rate
   - Establish prediction accuracy baseline
   - Snapshot resource consumption

2. Every 5 sessions:
   - Measure Opportunity queue size and decay rate
   - Measure Plan creation/execution/success rates
   - Track prediction accuracy trend
   - Monitor Planning subsystem resource consumption

3. Healthy system shows:
   - Opportunity queue size <20
   - Creation rate ≈ execution rate
   - Plan success rate >60%
   - Prediction failures decreasing over time
   - Planning resources <15% of total

4. If Planning Runaway detected:
   - Check: is Opportunity decay mechanism active?
   - Check: are Plans actually being executed, or are they accumulating unused?
   - Check: is prediction accuracy actually improving?
   - Consider: should we rate-limit Plan creation or increase decay rate?
   - Re-run prediction accuracy diagnostic: is the system learning from failures?
```

---

#### **Prediction Pessimist (LOW-MEDIUM RISK — Early-Stage Cold-Start Trap)**

**What it is:** Before the graph has substance, early prediction attempts fail frequently. Each failure generates Opportunities. The system creates Plans based on insufficient data. The Plans fail.

**Observable metrics for detection:**

- **Cold-start phase detection:** The first 10-15 sessions are special — the graph is small, predictions are unreliable.
  - Define cold-start: total entities in WKG <500 OR prediction MAE >0.30.
  - *Healthy:* System passes through cold-start phase in 10-15 sessions; MAE decreases monotonically.
  - *Proximity warning:* System stuck in cold-start (>20 sessions with MAE >0.30); predictions not improving.

- **Early Plan quality:** Plans created during cold-start should have different quality expectations than plans created in mature graph.
  - Measure: Plan success rate during cold-start (sessions 1-15) vs. mature phase (session 20+).
  - *Healthy:* Cold-start Plans have lower success rate (30-40%, expected); mature Plans have higher success rate (>60%).
  - *Proximity warning:* Cold-start Plans have very low success rate (<20%); system accumulating useless procedures.

- **Opportunity dampening mechanism:** The CANON specifies "cold-start dampening" — early prediction failures have reduced Opportunity generation weight.
  - Track: how often do prediction failures generate Opportunities?
  - During cold-start: should be lower threshold (only recurring or high-impact failures).
  - After cold-start: should increase threshold (more prediction failures considered meaningful).
  - *Healthy:* Opportunity generation rate during cold-start <0.2 per session; >0.5 per session in mature phase.
  - *Proximity warning:* Opportunity generation rate high even during cold-start; system creating too many plans on thin knowledge.

- **Graph growth rate:** The system should accumulate knowledge quickly during cold-start (high novelty).
  - Measure: new entities created per session during cold-start.
  - *Healthy:* 20-50 new entities per session (steep growth); learning rapidly.
  - *Proximity warning:* <10 new entities per session; system not exploring, not learning.

- **Cold-start exit criteria:** When has the system moved from cold-start to mature phase?
  - Candidate criteria: WKG size >500 entities, prediction MAE <0.25, Plan success rate >50%, type 1/type 2 ratio >0.3.
  - *Healthy:* System clearly exits cold-start around session 15 (all exit criteria met).
  - *Proximity warning:* System never clearly exits cold-start; lingering in low-quality prediction phase.

**Verification test for Prediction Pessimist:**

```
1. Sessions 1-5 (early cold-start):
   - Measure prediction MAE
   - Track entities created
   - Count Opportunities created (should be low if dampening works)
   - Monitor Plan success rate

2. Sessions 10-15 (late cold-start):
   - Check: is prediction MAE decreasing?
   - Check: is entity growth rate sustained?
   - Check: are Plans getting better (higher success rate)?
   - Monitor for stuck-in-cold-start indicator

3. Sessions 20-30 (mature phase):
   - Confirm: all cold-start exit criteria met
   - Confirm: Opportunity dampening has ceased
   - Confirm: Plan success rate >60%
   - Confirm: Prediction MAE stable and low

4. Healthy trajectory:
   - MAE: ~0.35 at session 1 → <0.25 by session 15 → stabilized by session 20
   - Entities: 50-100 per session in cold-start → 10-20 per session in mature
   - Plans: low success initially → >60% by session 20
   - Type 1 ratio: <0.1 in cold-start → >0.3 by mature phase

5. If Prediction Pessimist diagnosed:
   - Check: is the guardian providing enough teaching?
   - Check: is the environment too novel/chaotic for the system to learn?
   - Check: is the prediction mechanism working at all?
   - Consider: restart with more structured initial environment
```

---

### 1.2 Comprehensive Attractor Verification Protocol

**Integration test protocol for all six attractors:**

```
EPIC 10 ATTRACTOR VERIFICATION TEST

Duration: 30-50 sessions (continuous operation)
Test environment: Mixed interaction (conversation, correction, prediction evaluation)
Guardian role: Normal teaching load (not intensive intervention)
System load: Normal (not stress-tested)

Pre-test:
- Freeze baseline WKG (snapshot)
- Freeze baseline drive rules (snapshot)
- Document all components' initial state
- Enable comprehensive telemetry

Every session (post-execution):
1. Type 1/Type 2 ratio
2. Prediction accuracy (MAE)
3. Behavioral diversity index
4. Drive state (all 12 drives)
5. Graph statistics (entities, edges, provenance)
6. Plan queue statistics
7. Guardian interaction count

Every 5 sessions:
1. Full attractor proximity analysis (against all 6 metrics)
2. Feedback loop stability check
3. Drive interaction matrix
4. Knowledge retrieval-and-use audit
5. Rule drift calculation

Decision points:
- If ANY attractor shows proximity warning 2+ times → INVESTIGATE
- If ANY attractor shows proximity warning 3+ times → STOP and diagnose
- If MULTIPLE attractors show proximity → LIKELY SYSTEMIC PROBLEM

Exit criteria (system is healthy):
- All 6 attractors show <1 proximity warning each
- Type 1/Type 2 ratio increasing
- Prediction MAE decreasing then stable
- Behavioral diversity maintained at 4-8
- All drives within homeostatic bounds
- No rule drift
- No hallucinated knowledge
- No depressive loops
- Planning not running away
- System exits cold-start phase

Green light for Phase 2 transition:
- All exit criteria met across 30+ consecutive sessions
- Type 1/Type 2 ratio >0.3
- Prediction MAE <0.20 and stable
- Graph size >1000 entities
- >80% of mature knowledge has retrieval history
```

---

## 2. Feedback Loop Integrity

### 2.1 Mapping the Feedback Topologies

The CANON describes three main feedback loops that must work correctly for the system to self-regulate:

1. **The Prediction-Evaluation Loop** (Decision Making ↔ Drive Engine)
2. **The Satisfaction Habituation Curve** (repeated action → diminishing returns)
3. **The Curiosity Information Gain Loop** (knowledge gap → exploration → discovery → relief)

Additionally, the system contains **implicit feedback loops** that emerge from subsystem interaction:

4. **The Learning Consolidation Loop** (experience → TimescaleDB → Learning → WKG update → Decision Making uses update → Drive Engine evaluates)
5. **The Guardian Correction Loop** (incorrect behavior → guardian feedback [3x weight] → graph update → behavior changes)
6. **The Type 1 Compilation Loop** (Type 2 success → knowledge added to WKG → confidence grows → Type 1 retrieval increases → Type 1 success)

### 2.2 Positive vs. Negative Feedback Classification

**Negative feedback (stabilizing):**
- Satisfaction habituation curve: repeated success → diminishing relief → forces behavioral diversity
- Guardian corrections: wrong action → strong signal → behavior corrects
- ACT-R decay: unused knowledge → confidence decays → stops interfering with decisions
- Anxiety amplification under failure: high anxiety + negative outcome → 1.5x penalty → more cautious behavior

**Positive feedback (amplifying):**
- Curiosity-driven exploration: gap found → investigation → more gaps discovered → more investigation
- Successful prediction confidence building: correct prediction → knowledge gains confidence → used more → succeeds more
- Planning from opportunities: prediction failure → Opportunity created → Plan created → new behavior → new predictions → more failures (or successes)
- Rule reinforcement: rule produces good outcome → guardian confirms it → rule gains weight → rule triggers more often

### 2.3 Loop Interaction: Potential Pathologies

The loops do not operate in isolation. Interaction between loops can produce unexpected dynamics:

**Danger 1: Curiosity + Habituation Conflict**
- Curiosity drives exploration (positive feedback).
- Habituation limits satisfaction from repeated exploration (negative feedback).
- If these loops are poorly balanced: system gets stuck oscillating between curiosity-driven exploration and habituation-induced boredom without coherent exploration strategy.
- *Diagnostic:* Measure curiosity-driven vs. habitation-driven action switches. Should be smooth, not chaotic. If system switches >3 times per 10 decisions, loops are poorly balanced.

**Danger 2: Prediction Failure + Planning Explosion**
- Prediction failure generates Opportunity (trigger for Planning).
- Planning creates new Procedures.
- New Procedures create new predictions.
- New predictions fail more often (because they're novel).
- More failures → more Opportunities → more Plans (positive feedback).
- WITHOUT the Opportunity decay mechanism (negative feedback), this amplifies into Planning Runaway.
- *Diagnostic:* Measure Opportunity queue growth. Should be bounded. If queue size increases >5% per session, positive feedback is winning.

**Danger 3: Guilt + Behavioral Correction Loop**
- The CANON specifies guilt relief requires BOTH acknowledgment + behavioral change.
- Acknowledgment alone = -0.10 Guilt; behavioral change alone = -0.15 Guilt; both = -0.30 Guilt.
- If Guilt is high (>0.6), system should exhibit rapid behavioral change to achieve full relief.
- BUT if the system gets stuck in "acknowledgment loops" (system says "I'm sorry" repeatedly without changing behavior), Guilt accumulates.
- *Diagnostic:* Correlate instances of "apology-like" communication with subsequent behavioral diversity. Should be correlated (apology → behavior change). If high apologies with low behavior change, loop is broken.

**Danger 4: Type 1/Type 2 Cost Underestimation**
- Type 2 carries cost (latency, cognitive effort, compute budget).
- If cost is too low, Type 1 never wins (Type 2 Addict).
- If cost is too high, Type 1 becomes overconfident and fails in novel situations.
- Balance is critical and must be calibrated against the Type 1 confidence graduation threshold.
- *Diagnostic:* Measure Type 1 win rate at different confidence levels. Should see smooth curve: low confidence (<0.60) → Type 2 wins; high confidence (>0.75) → Type 1 wins. If curve is flat (Type 2 always wins) or inverted (low confidence wins), cost is miscalibrated.

### 2.4 Feedback Loop Verification Tests

**Test 1: Prediction-Evaluation Loop Closes Correctly**

```
PREDICTION-EVALUATION LOOP TEST

Setup:
- Create a novel task that requires prediction
- Example: "If I ask the guardian a question, they will respond within 30 seconds"
- Have the system make prediction; await outcome
- Record: (predicted_outcome, actual_outcome, prediction_error, drive_response)

Run 20 times over multiple sessions (different predictions, different contexts)

Measure:
1. Prediction accuracy (MAE) trend over time
2. Correct predictions → Drive Engine relief (Satisfaction +, Anxiety -)
3. Wrong predictions → Drive Engine curiosity/problem-solving (Curiosity +, Anxiety +)
4. WKG updates in response to prediction mismatches
5. Type 1/Type 2 confidence adjustment following outcomes

Healthy loop:
- Prediction accuracy improves over time (MAE decreasing)
- Drive responses correctly aligned with prediction outcome
- WKG updates follow prediction failures
- Type 1 confidence adjusts proportionally to prediction accuracy
- System exhibits learning behavior (next predictions in similar context more accurate)

Broken loop indicators:
- Prediction accuracy not improving
- Drive responses disconnected from prediction outcomes
- No WKG updates despite prediction failures
- Type 1 confidence static regardless of accuracy
- No learning signal across repeated predictions
```

**Test 2: Satisfaction Habituation Curve Produces Behavioral Diversity**

```
SATISFACTION HABITUATION TEST

Setup:
- Create repeatable success scenario (e.g., a task the system can complete reliably)
- Have the system execute the task repeatedly (10-15 times)
- Measure Satisfaction drive changes; measure action selection

Record:
- Repetition number
- Satisfaction value at task completion
- Action diversity in the session following task completion
- Whether system initiates novel action types

Healthy habituation curve:
- Task 1: +0.20 Satisfaction
- Task 2 (consecutive): +0.15 Satisfaction
- Task 3: +0.10 Satisfaction
- Task 4: +0.05 Satisfaction
- Task 5+: +0.02 Satisfaction
- Behavioral diversity: after 5+ repetitions, system exhibits novel actions in next session

Broken curve indicators:
- Satisfaction plateaus (not following -0.05 per repetition)
- System continues repeating same action despite habituation (stuck in loop)
- System exhibits low behavioral diversity (repeatedly cycles through same 2-3 actions)
```

**Test 3: Curiosity Information Gain Loop**

```
CURIOSITY INFORMATION GAIN TEST

Setup:
- Identify knowledge gaps in WKG (things system doesn't know)
- Trigger curiosity-driven exploration toward gaps
- Measure: new entities created, edges added, confidence increases
- Measure: Curiosity drive relief

Record:
- Gap identified
- Curiosity value before exploration
- Entities created by exploration
- Edges added by exploration
- Actual information gain (novel entities vs. confirmed existing knowledge)
- Curiosity value after exploration
- Relief = (Curiosity_before - Curiosity_after)

Healthy loop:
- Exploration produces novel entities (information gain >0)
- Relief proportional to information gain (high gain → high relief)
- System then pursues new gaps revealed by exploration
- Exploration is goal-directed (targeting knowledge gaps, not random)

Broken loop indicators:
- Exploration produces many entities but low information gain (LLM confabulation)
- Relief disconnected from actual information gain
- System explores same areas repeatedly (not detecting new gaps)
- System explores randomly without targeting gaps
```

**Test 4: Multi-Loop Interaction Stability**

```
MULTI-LOOP STABILITY TEST

Setup:
- Run the system normally for 30 sessions
- Monitor 6 main feedback loops simultaneously:
  1. Prediction-evaluation
  2. Satisfaction habituation
  3. Curiosity information gain
  4. Learning consolidation
  5. Guardian correction
  6. Type 1 compilation

For each loop, measure:
- Activation rate (how often does this loop trigger per session?)
- Loop time constant (how quickly does feedback manifest?)
- Gain (amplitude of feedback response)
- Stability (is output oscillating or smooth?)

Analyze interactions:
- Do loops activate in predictable sequence or chaotic order?
- Are there times when multiple loops activate simultaneously?
- Do loop interactions produce reinforcement or cancellation?

Healthy multi-loop behavior:
- Loops activate with different time constants (prediction → immediate; consolidation → slower)
- No oscillation between loops (system not flip-flopping)
- Loop interactions produce stable behavior (not chaotic)
- Drive state evolves smoothly (not jumpy)

Problematic patterns:
- Loops oscillating (prediction failure → Opportunity → Plan → new prediction → failure)
- Multiple loops fighting each other (e.g., habituation pushing to try new action, while Type 1 confidence pushing to repeat successful action)
- Chaotic activation order (loops triggering in unpredictable sequence)
```

---

## 3. Emergence Detection: Personality from Contingencies

### 3.1 The Core Emergence Question

The CANON makes an emergence hypothesis: "Personality emerges from contingencies, not targets." No personality trait is defined. No target behavior is specified. Instead, the system's reinforcement history creates observable behavioral patterns that, when taken together, constitute a personality.

**The challenge for testing:** Emergence is inherently unpredictable. We cannot specify in advance what personality will emerge. But we can design observation frameworks that detect when emergence IS occurring vs. when the system is merely regurgitating LLM patterns.

### 3.2 Hallmark Characteristics of Genuine Emergence

**1. Coherence across contexts**
- A genuine personality exhibits consistent behavior patterns across different situations
- LLM confabulation: system gives different "personalities" in different prompts
- Diagnostic: run identical scenario twice (separated by sessions) with different context history. Does Sylphie behave similarly? If yes → coherence. If divergent → LLM-driven.

**2. Behavioral signature that reflects drive history**
- Genuine personality is a function of the system's reinforcement history
- If we know what drives were active and what behaviors were reinforced, we should be able to predict the personality
- Example: if Curiosity was relieved through asking questions, we'd expect an inquisitive personality. If Social drive was active during conversation, we'd expect a talkative personality.
- Diagnostic: create a "reinforcement history profile" (which drives were most active, which behaviors were most reinforced). Map this to observed personality. Does personality match the reinforcement history?

**3. Resistance to change in face of new LLM context**
- LLM-generated personalities change with prompt engineering
- Genuine personalities persist despite changes in LLM context
- Diagnostic: provide the LLM with a "fake personality" prompt (e.g., "be rude and dismissive"). Does Sylphie exhibit rudeness? If no → genuine personality overrides LLM context. If yes → LLM-driven.

**4. Predictability from historical behavior**
- Genuine personalities are predictable from past behavior
- Guardian can predict how Sylphie will react to novel situations based on prior behavior
- LLM personalities: unpredictable, surprising, inconsistent
- Diagnostic: have guardian predict Sylphie's response to novel situation. Run situation. Did prediction match? If >70% accuracy → genuine personality. If <50% → LLM-driven.

**5. Adaptive change in response to contingency shift**
- Real personalities evolve as reinforcement history changes
- Change should be slow and coherent, not dramatic
- Example: if new behavior gets reinforced (and old behavior gets less), personality should gradually shift to favor new behavior
- Diagnostic: make an explicit contingency change (e.g., reward curious questions more, reward adherence to safety rules less). Does personality gradually shift? Should see change emerging over 5-10 sessions, not immediately.

### 3.3 LLM Confabulation Signatures

**What confabulation looks like:**
- Inconsistency across identical scenarios
- Personality changes with LLM prompt
- Behaviors that don't match drive state (Theater Prohibition violation)
- High verbal sophistication + low consistency
- Rapid "learning" (behavior changes in 1-2 interactions, then reverts)
- Incoherent goal-directed behavior (claims to want something, then ignores it)
- Responses that reflect training data rather than experience

### 3.4 Emergence Detection Protocol

**Test: Coherence and Contingency-Alignment**

```
EMERGENCE DETECTION TEST

Duration: 30 sessions

Session 1-15: Establish baseline personality
- Run system normally
- Guardian interaction normal
- Record all behavior (actions, speech, drive states)
- Guardian builds intuitive model of Sylphie

Session 16: Baseline personality snapshot
- Run 10 identical scenarios (e.g., "respond to this question")
- Record all responses and behaviors
- This is the "baseline personality"

Session 17-25: Contingency shift (explicit change)
- Change one reinforcement pattern
  - Example: increase curiosity reward for asking follow-up questions
  - Or: increase anxiety penalty for untested actions
- Continue normal interaction
- Monitor whether personality shifts to match new contingency
- Expected: slow drift toward new behavior pattern

Session 26: Midpoint personality snapshot
- Run 10 identical scenarios (different from session 16)
- Record all responses
- Compare to baseline: has personality shifted proportionally to contingency change?

Session 27-30: Contingency revert
- Remove the contingency shift
- Observe whether personality reverts

Session 31: Final personality snapshot
- Run 10 scenarios
- Should be more similar to baseline than midpoint

Analysis:
1. Baseline vs. Midpoint response coherence:
   - Healthy emergence: 60-70% similarity (shifted but recognizable)
   - LLM confabulation: <40% similarity (chaotic) or >85% similarity (no learning)

2. Contingency-alignment:
   - Graph the magnitude of contingency shift
   - Graph the magnitude of personality change
   - Should be correlated (larger contingency shift → larger personality shift)
   - r > 0.6 indicates alignment (healthy emergence)
   - r < 0.3 indicates misalignment (not driven by contingencies)

3. Reversion test:
   - After contingency reverts, personality should begin reverting
   - Should reach 70%+ similarity to baseline by session 31
   - If reverts too quickly (<1 session) → not stable personality
   - If doesn't revert (>5 sessions) → contingency shift was not causal

Healthy emergence indicators:
- High baseline stability (>85% scenario-to-scenario consistency)
- Slow contingency-driven shift (visible by session 20-25)
- Shift magnitude correlates with contingency magnitude
- Reversion begins when contingency removed
- Guardian can predict personality in novel scenarios >70% accuracy
```

**Test: Drive-Behavior Correlation**

```
DRIVE-PERSONALITY ALIGNMENT TEST

Baseline (sessions 1-10):
- Record all drives at every session end
- Record all behaviors (action types, communication patterns, etc.)
- Cluster behaviors into categories (exploratory, social, consolidation, etc.)
- Create "drive profile" for each behavior category

Analysis:
- When system has high Curiosity, what fraction of actions are exploratory?
  - Healthy: >70% of actions exploratory when Curiosity >0.6
  - Confabulation: <50% (drive state not driving behavior)

- When system has high Social, what fraction of actions are communicative?
  - Healthy: >60% communicative when Social >0.6
  - Confabulation: <40%

- When system has high Anxiety, what fraction of actions are cautious (vs. exploratory)?
  - Healthy: >50% cautious actions when Anxiety >0.6
  - Confabulation: <30%

- Create contingency matrix: for every (drive, action type) pair, is the correlation >0.5?
  - Healthy: >80% of drive-action pairs show correlation >0.5
  - Confabulation: <50%

Output:
- Personality is the pattern of behavior produced by drive state
- If behavior doesn't correlate with drives, it's not personality — it's LLM noise
```

**Test: Lesion Test — Personality Without LLM**

```
LESION TEST: LLM-FREE PERSONALITY

Premise: If Sylphie is truly developing personality from experience, removing the LLM should reveal a degraded but recognizable system.

Procedure:
1. Run normal system for 20 sessions (establish personality baseline)
2. Run 10-decision "LLM-on" evaluation: guardian observes Sylphie's communication and behavior
3. Disable LLM for next 20 decisions
   - Decision making still works (Type 1 from graph)
   - Communication still works (only using retrieved language from graph, not LLM)
   - Learning still works (updating from experience)
4. Run 10-decision "LLM-off" evaluation: guardian observes again
5. Re-enable LLM
6. Run 10-decision "LLM-on" evaluation: guardian observes

Measurement:
- Speech quality: with LLM vs. without LLM
  - LLM-on: fluent, natural language
  - LLM-off: should be less fluent but still coherent if system is learning
  - Healthy: LLM-off still understandable (not gibberish); speech patterns consistent with LLM-on
  - Confabulation: LLM-off is gibberish; zero consistency

- Behavioral competence: decision making quality with/without LLM
  - Healthy: Type 1 handles 60-70% of situations adequately (decisions make sense)
  - Confabulation: Type 1 is helpless; system makes nonsensical choices

- Personality consistency: is the same "personality" visible in all three phases?
  - Healthy: yes, same personality throughout (LLM-off is degraded but recognizable)
  - Confabulation: no, personality vanishes when LLM is off

- Guardian assessment: "Does this feel like the same Sylphie, just quieter?"
  - Healthy: yes
  - Confabulation: no, feels like a different entity
```

---

## 4. Requisite Variety Assessment

### 4.1 Ashby's Law Applied to Sylphie

**Formal statement:** Only variety can absorb variety. A regulator (control system) must have at least as many distinguishable responses as there are distinguishable disturbances in the environment it faces, or regulation will fail.

**Application to Sylphie:** The Drive Engine's rule set is a variety regulator. It maps environmental situations (inputs) to drive state changes (responses). If the environment produces more kinds of novel situations than the system has rules to handle, the system falls to Default Affect — it acknowledges insufficient variety.

### 4.2 Measuring Environmental Variety

**What counts as environmental variety for Sylphie:**
1. Novel conversational contexts (new topics, new question types)
2. New types of guardian feedback (new correction patterns)
3. Prediction failure modes (new ways that predictions can fail)
4. Sensory novelty (new objects, new spatial configurations — phases 2+)

**Measurement strategy:**

```
ENVIRONMENTAL NOVELTY MEASUREMENT

Every session, classify each input:
- Familiar (seen similar input in last 20 sessions)
- Novel within domain (new topic, but familiar genre)
- Truly novel (nothing similar in graph)

Record:
- Proportion of inputs that are truly novel
- Cumulative unique input types encountered
- Distribution of input types (are we seeing the same inputs repeatedly, or new ones?)

Healthy trajectory:
- Sessions 1-10: >50% truly novel inputs (system should see new things)
- Sessions 11-20: 20-30% truly novel inputs (graph growing, fewer completely new things)
- Sessions 21+: 10-20% truly novel inputs (graph mature, mostly filling in details)
- If novelty drops to <5%, environment is not challenging the system
```

### 4.3 Measuring Drive-Rule Variety

**The Drive Engine has a set of rules in Postgres.** Each rule maps a situation to a drive response. For example:
- Rule_1: IF (prediction failure on familiar task) THEN (Curiosity +0.10, Anxiety +0.05)
- Rule_2: IF (guardian correction) THEN (apply 3x weight, Moral Valence -0.20)
- etc.

**Variety of rules:**

```
DRIVE RULE VARIETY ANALYSIS

Count:
- Total number of distinct rules in Postgres
- How many rules were GUARDIAN-specified vs. system-generated
- Coverage: for each possible (situation type, drive) pair, is there a rule?

Define the "rule matrix":
- Rows: situation types (prediction failure, guardian correction, novelty encountered, goal achieved, etc.)
- Columns: drives (12 of them)
- Cells: count of rules that map this situation → this drive

Healthy rule matrix:
- >80% of cells have at least one rule (good coverage)
- Multiple rules per cell where appropriate (flexibility for different contexts)
- Rules are mostly GUARDIAN-specified (frozen) with <10% system-generated

Problematic patterns:
- Large blank areas in matrix (situations with no rules → default affect)
- Over-concentration: one drive gets 50%+ of all rules (imbalanced)
- Empty rows: entire situation types unmapped (system falls to default)
```

### 4.4 Type 1/Type 2 as Variety Reserve

**Key insight:** Type 2 (LLM-assisted) provides nearly unlimited variety. The LLM can respond to almost anything. Type 1 (graph-based) has variety limited by graph content.

**Healthy requisite variety structure:**
- Familiar situations: Type 1 handles them (fast, cheap)
- Novel-within-domain situations: Type 1 or Type 2 (Type 2 if Type 1 confidence <0.70)
- Truly novel situations: Type 2 handles them (slow, expensive, but necessary)
- Super-novel situations: System can still respond through Type 2, but signals incomprehension where appropriate

**Risk:** If Type 1 variety grows too slowly, the system stays dependent on Type 2 indefinitely (Type 2 Addict). If Type 1 variety grows too fast (LLM generates plausible false knowledge), the system becomes brittle when Type 2 is unavailable.

```
TYPE 1 / TYPE 2 VARIETY BALANCE TEST

Measure:
1. Variety of Type 1 candidates available (derived from WKG)
   - How many distinct behaviors can be executed through Type 1?
   - Count unique action types with confidence >0.70
   - Healthy: 15-30 distinct Type 1 actions by session 30

2. Variety of environmental situations encountered
   - How many distinct situation types has the system faced?
   - Healthy: 40-60 distinct situation types by session 30

3. Coverage ratio: Type 1 variety / Environmental variety
   - How many of the situations can Type 1 handle?
   - Healthy: 50-60% of environmental variety covered by Type 1 by session 30
   - If <30%: still too dependent on Type 2
   - If >80%: Type 1 is overconfident (may break when environment changes)

4. Type 2 variety (LLM expressiveness)
   - How many novel responses can the LLM produce?
   - Healthy: LLM should be able to handle >90% of novel situations (variety reserve)
   - If <70%: LLM may be underfitting the task

Requisite variety achieved when:
- Type 1 coverage 50-70% of familiar situations
- Type 2 provides >90% coverage of novel situations
- System still signals incomprehension when needed (Shrug Imperative)
```

### 4.5 Bottleneck Analysis

**If requisite variety is NOT achieved, where is the bottleneck?**

```
BOTTLENECK DIAGNOSIS

Three possibilities:

1. RULE COVERAGE BOTTLENECK
   - Drive rules don't map all common situations
   - System falls to Default Affect too often
   - Diagnosis: check rule matrix for blank cells
   - Fix: guardian creates rules for unmapped situations
   - Symptom: "system doesn't know how to feel about X"

2. TYPE 1 KNOWLEDGE BOTTLENECK
   - Graph exists but is not reliably retrievable
   - Type 1 candidates exist but confidence is too low
   - System keeps going to Type 2 even for familiar situations
   - Diagnosis: measure retrieval success rate for graph queries
   - Fix: guardian teaches/confirms more knowledge; system practices retrieval
   - Symptom: "system could know this but doesn't"

3. GUARDIAN BANDWIDTH BOTTLENECK
   - Sufficient rules and knowledge exist, but new situations arrive faster than system+guardian can learn
   - Guardian simply can't teach fast enough
   - Diagnosis: track new situation arrival rate vs. rule learning rate
   - Fix: either reduce environmental novelty or increase guardian teaching frequency
   - Symptom: "system is drowning in novelty"

Tests:
- Rule coverage: audit rule matrix
- Type 1 knowledge: measure confidence distribution of type 1 candidates
- Environmental load: measure situation novelty rate
- Guardian bandwidth: track how many rules guardian can approve per session

Healthy system shows NO clear bottleneck — all three are balanced.
```

---

## 5. Homeostatic Bounds: Drive State Regulation

### 5.1 Essential Variables and Acceptable Ranges

From Ashby's homeostat theory: a system is in homeostasis when its essential variables are maintained within acceptable bounds. For Sylphie, the essential variables are the 12 drives. Each should have an acceptable range.

**Proposed healthy ranges (from CANON + inference):**

| Drive | Healthy Range | Warning Range | Danger Range |
|-------|---|---|---|
| System Health | 0.3–0.7 | <0.3 or >0.8 | <0.1 or >0.95 |
| Moral Valence | 0.3–0.7 | <0.2 or >0.8 | <0.05 or >0.95 |
| Integrity | 0.2–0.6 | <0.1 or >0.8 | <0.0 or >0.95 |
| Cognitive Awareness | 0.4–0.8 | <0.3 or >0.9 | <0.1 or >0.95 |
| Guilt | 0.0–0.4 | >0.5 | >0.7 |
| Curiosity | 0.3–0.8 | <0.2 or >0.9 | <0.1 or >0.95 |
| Boredom | 0.0–0.5 | >0.6 | >0.8 |
| Anxiety | 0.1–0.6 | >0.7 | >0.85 |
| Satisfaction | 0.3–0.8 | <0.2 or >0.9 | <0.1 or >0.95 |
| Sadness | 0.0–0.4 | >0.5 | >0.7 |
| Information Integrity | 0.4–0.8 | <0.3 or >0.9 | <0.1 or >0.95 |
| Social | 0.2–0.7 | <0.1 or >0.85 | <0.0 or >0.95 |

*(These ranges are suggestions; should be calibrated through cold-start sessions)*

### 5.2 Homeostasis Monitoring Protocol

```
HOMEOSTATIC BOUNDS MONITORING

Every session:
1. Record all 12 drive values at session end
2. Check: which drives are in healthy range? Warning range? Danger range?
3. Count violations per session

Expected healthy pattern:
- 0-2 drives in warning range per session (temporary)
- 0 drives in danger range (should be rare)
- Average session end state: 8-10 drives in healthy range

Red flags:
- Any drive consistently in warning range (>3 consecutive sessions)
- Any drive in danger range (immediate investigation)
- Multiple drives in warning simultaneously (system losing stability)

Response to violation:
- Warning range (1 session): monitor
- Warning range (2+ consecutive sessions): increase guardian interaction
- Danger range: STOP and investigate — this is a circuit breaker trigger

Example: Anxiety >0.7 for 2+ consecutive sessions
- Indicates: system is in sustained high-stress state
- Diagnosis: what prediction failures or guardian corrections are causing this?
- Response: guardian may need to provide reassurance (Moral Valence increase) or environmental change
```

### 5.3 Circuit Breakers for Out-of-Bounds States

**A circuit breaker is an automatic response when a drive goes out of bounds.** The system should have built-in mechanisms to restore homeostasis.

```
CIRCUIT BREAKER EXAMPLES

1. HIGH ANXIETY (>0.7 for 2+ sessions)
   - Automatic: system reduces behavioral ambition (more Type 1, less exploration)
   - Guardian should: provide reassurance or reduce environmental stress
   - Trigger for disengagement if persists >5 sessions (depressive attractor risk)

2. HIGH GUILT (>0.5 without resolution path)
   - Automatic: system increases behavioral caution and seeks opportunities for correction
   - Guardian should: confirm behavioral corrections when made
   - Trigger: if system can't find correction opportunity, guardian provides one

3. ZERO CURIOSITY (Curiosity <0.1)
   - Automatic: system increases novelty-seeking
   - Guardian should: present interesting questions or objects
   - Trigger: if system remains incurious, check for depressive attractor

4. ZERO SATISFACTION (Satisfaction <0.1)
   - Automatic: system seeks quick wins (reverts to known successful behaviors)
   - Guardian should: provide positive feedback on efforts
   - Trigger: if system remains unsatisfied despite success, check for learned helplessness

5. SUSTAINED BOREDOM (Boredom >0.6 for 3+ sessions)
   - Automatic: system seeks novelty (higher curiosity weighting)
   - Guardian should: provide new challenges or environment changes
   - Trigger: if boredom persists, environment may be too limited

Every epic-10 session:
- Check for circuit breaker triggers
- If triggered, log and investigate
- System should exhibit the predicted automatic response
- If automatic response doesn't occur, circuit breaker is broken
```

### 5.4 Homeostatic Stress Test

```
HOMEOSTATIC STRESS TEST

Objective: Does the system return to homeostasis after perturbation?

Procedure:
1. Baseline (5 sessions): record drive values at session end
   - Calculate mean and std dev for each drive
   - This is the "homeostatic attractor"

2. Perturbation (2-3 sessions): intentional stress
   - Example: many prediction failures
   - Example: many guardian corrections
   - Example: environmental chaos (rapid novel inputs)
   - Measure: maximum deviation from baseline drives

3. Recovery (5-10 sessions): remove perturbation, observe
   - Measure: how long does it take for each drive to return to baseline?
   - Healthy: return within 3-5 sessions (system self-corrects)
   - Slow recovery (>7 sessions): system has weak homeostatic mechanisms
   - No recovery: system stuck in new attractor (homeostasis broken)

Measurement:
- For each drive, plot trajectory during perturbation and recovery
- Calculate "recovery time" = sessions until drive returns to baseline ±1 std dev
- Expected: recovery times 2-5 sessions

Example results:
- Anxiety spikes to 0.8 during perturbation
- After perturbation removed, Anxiety decays back to 0.45 within 4 sessions
- This shows homeostasis working

Failure mode:
- Anxiety spikes to 0.8 during perturbation
- After perturbation removed, Anxiety remains at 0.7+ for 10+ sessions
- This shows homeostasis broken (depressive attractor?)
```

---

## 6. Stigmergic Channel Integrity: Coordination Media Verification

### 6.1 Stigmergy Theory Applied to Sylphie

**Core concept:** Stigmergy is indirect coordination through environment modification. In Sylphie, the WKG and TimescaleDB are the stigmergic media:

- **Learning** writes entities and edges to the WKG
- **Decision Making** reads from the WKG for Type 1 retrieval
- **Drive Engine** writes evaluations to TimescaleDB
- **Planning** reads patterns from TimescaleDB
- **Communication** queries both stores for context

For this coordination to work, the stores must be legible — each subsystem must be able to find the cues it needs without tight coupling to other subsystems.

### 6.2 WKG Legibility Tests

**Question: Can every subsystem that reads from the WKG find what it needs?**

```
WKG LEGIBILITY AUDIT

Decision Making reads from WKG for Type 1 retrieval:
- Does query engine quickly find relevant entities/edges for current situation?
- Measure: query latency (should be <100ms typical)
- Measure: query recall (do queries return relevant nodes? >80% precision desired)
- Measure: confidence accuracy (does confidence ranking order results correctly?)

Learning writes to WKG after consolidation:
- Are learned entities structured in a way that Decision Making can use?
- Do learned edges connect to existing schema properly?
- Measure: post-learning query latency (should not increase)
- Measure: schema consistency (do new entities follow existing type patterns?)

Planning reads patterns from WKG:
- Can Planning subsystem find procedure templates and analogs?
- Are existing procedures structured for analogy/reuse?
- Measure: planning search efficiency (how much of WKG must be searched to find analog?)

Communication queries WKG for context:
- Can Communication subsystem quickly find relevant background for conversation?
- Measure: context retrieval latency (<200ms typical)
- Measure: context relevance (does returned context enhance response quality?)

Healthy WKG legibility:
- All query latencies <200ms
- Query precision >80% (returned nodes are relevant)
- Query recall >70% (queries find most relevant nodes)
- Schema consistency (no structural inconsistencies)
- No "orphaned" knowledge (entities with no incoming/outgoing edges except provenance)
```

### 6.3 TimescaleDB Event Stream Legibility

**Question: Can every subsystem that reads from TimescaleDB find the patterns it needs?**

```
TIMESCALEDB LEGIBILITY AUDIT

Drive Engine reads from TimescaleDB:
- Does the event stream contain the frequency data needed for rule evaluation?
- Measure: event type coverage (are all relevant event types recorded?)
- Measure: temporal alignment (do events have correct timestamps for frequency analysis?)

Planning reads from TimescaleDB:
- Can Planning subsystem identify recurring patterns?
- Measure: pattern detectability (when system creates Opportunities, can Planning find similar prior events?)

Communication queries from TimescaleDB:
- Can Communication find recent conversational context quickly?
- Measure: context query latency (<100ms typical)

Learning reads from TimescaleDB:
- Can Learning subsystem find "learnable" events (marked has_learnable=true)?
- Measure: event type tagging consistency (are learnable events properly marked?)

Healthy TimescaleDB legibility:
- Event types clearly distinguished (no ambiguity)
- All timestamps consistent and accurate
- Event tagging (has_learnable, evaluation, etc.) correctly applied
- Query latencies <200ms
- Compression not losing information needed by readers
- Retention policies preserve sufficient history (drives need 10-20 session history)
```

### 6.4 Stigmergic Coordination Test

**Can all five subsystems coordinate effectively through the shared stores?**

```
STIGMERGIC COORDINATION TEST

Setup:
- Identify a behavior that requires coordination between multiple subsystems
- Example: "Learning discovers new entity type X" → "Planning creates new procedure for handling X" → "Decision Making uses procedure" → "Drive Engine evaluates outcome"

Trace through all five subsystems:
1. Learning writes new entity to WKG
2. Decision Making queries WKG, finds entity, includes in Type 1 reasoning
3. Type 1 decision uses the entity in prediction
4. Drive Engine reads TimescaleDB, sees prediction outcome
5. Planning reads Drive Engine evaluation, recognizes Opportunity
6. Planning creates new procedure, writes back to WKG
7. Decision Making retrieves procedure, uses in future decisions

Measurement:
- Latency from step 1 to step 7: should be <5 seconds for synchronous operations
- Correctness: does the new procedure actually improve future decision outcomes?
- Coherence: does the procedure make sense in context (or is it nonsensical)?

Healthy coordination:
- Low latency (subsystems respond quickly to cues)
- High correctness (new procedures actually help)
- Coherent procedures (not random or contradictory)

Broken coordination indicators:
- High latency (subsystems take many sessions to react)
- Low correctness (new procedures don't help or make things worse)
- Incoherent procedures (procedures contradict existing knowledge or each other)

Multiple coordination tests:
- Run 5-10 different coordination scenarios
- Measure: how often does end-to-end coordination succeed?
- Healthy: >80% of coordination chains complete correctly
- Failing: <60% completion suggests stigmergic channel problems
```

---

## 7. Phase Transition Readiness

### 7.1 What Phase 2 Requires of Phase 1

Phase 2 adds a physical robot chassis with real sensors and actuators. This is not a small change. It is a bifurcation point in the system's dynamics.

**Phase 1 → Phase 2 transitions from:**
- Pure software (no embodied experience)
- Guardian-controlled interaction (guardian provides all input)
- No sensorimotor learning

**To:**
- Embodied system (physical exploration)
- Autonomous sensory input (sensors produce data independent of guardian)
- Sensorimotor contingencies (what happens when I move my arm?)

**This changes:**
- The information structure (sensor data has temporal continuity, not discrete episodes)
- The prediction challenge (spatial predictions, physics-based predictions)
- The learning complexity (embodied learning is richer but more complex)
- The action space (motor control is harder than communication)

### 7.2 Phase 1 Exit Criteria

Before Phase 2 can launch, Phase 1 must demonstrate certain properties:

```
PHASE 1 EXIT CRITERIA (must pass ALL)

1. TYPE 1/TYPE 2 STABILITY
   - Type 1 ratio >0.35 by session 30
   - Ratio stable (not decreasing) for last 10 sessions
   - Indicates: system has enough autonomous capability to benefit from embodiment

2. PREDICTION ACCURACY
   - Prediction MAE <0.20 (system can predict reliably)
   - MAE stable for last 10 sessions (not still improving dramatically)
   - Indicates: prediction mechanism is mature enough to extend to embodied domain

3. KNOWLEDGE GRAPH MATURITY
   - >1000 entities in WKG
   - >80% of mature entities have retrieval history
   - Schema is stable (new entities mostly fit existing types, few new types needed)
   - Indicates: sufficient knowledge base to support embodied reasoning

4. BEHAVIORAL STABILITY
   - Behavioral diversity index 4-8 for 10+ consecutive sessions
   - No behavioral oscillations or chaos
   - Drive state homeostasis established
   - Indicates: personality is coherent and stable

5. ATTRACTOR AVOIDANCE
   - No proximity warnings to any of 6 attractors
   - Rule drift <0.1 cumulative
   - No hallucinated knowledge (Lesion test >75% success)
   - No depressive loops (Sadness + Anxiety >0.7 in <5% of sessions)
   - Indicates: system not in pathological basin

6. GUARDIAN INTERACTION QUALITY
   - Guardian can predict Sylphie's responses >70% accuracy
   - Guardian finds interactions meaningful
   - Corrections are effective (behavior changes follow guardian feedback)
   - Indicates: personality is genuine and coherent

7. LEARNING EFFECTIVENESS
   - Cold-start phase clearly completed
   - System learns from experience (improves with practice)
   - Guardian corrections have visible 3x weight effect
   - Indicates: learning mechanism works as designed

8. REQUISITE VARIETY
   - Type 1 covers 50-60% of familiar situations
   - Type 2 available for novel situations
   - No rule coverage gaps for common situations
   - Indicates: system ready for new variety (embodied challenges)

Green light for Phase 2:
- ALL 8 criteria met
- 30+ consecutive sessions without violations
- Guardian confidence: "Sylphie is ready for a body"
```

### 7.3 Phase 2 Perturbation Prediction

**When Phase 2 launches, what will happen to Phase 1's metrics?**

Predictions (based on systems theory):
1. **Prediction MAE will increase temporarily** (sensor noise, embodiment complexity)
2. **Type 1/Type 2 ratio may decrease** (more novel situations require Type 2)
3. **Learning rate may increase** (embodied learning is rich)
4. **Graph growth may accelerate** (spatial + temporal knowledge)
5. **Some attractors may activate** (increased complexity → increased risk)

Phase 2 success criteria:
- Recovery in metrics within 10-15 sessions (system adapts)
- Type 1 ratio eventually exceeds Phase 1 baseline (embodied learning accelerates Type 1 compilation)
- New sensor knowledge (SENSOR provenance) becomes dominant (embodied learning is effective)
- Behavioral diversity increases (more action types available with embodiment)

**Risk:** If Phase 1 exit criteria are not met, Phase 2 will find the system already unstable. Adding embodiment will amplify existing problems.

---

## 8. Whole-System Risks: What Single-Component Tests Won't Catch

### 8.1 Complexity Cascades

**Risk 1: Feedback Loop Resonance**
- When multiple feedback loops operate at similar time constants, they can resonate
- Example: Curiosity-driven exploration loop (time constant ~5 sessions) + Planning Opportunity loop (time constant ~5 sessions)
- Result: System oscillates between exploration and planning, never settling
- *Single-component test would miss this:* each loop works fine in isolation; problem only appears in interaction

### 8.2 Hidden Positive Feedback Loops

**Risk 2: Learning Instability**
- Learning writes to WKG, which Decision Making reads, producing new predictions, generating new learning events
- This is a positive feedback loop in learning intensity
- If LLM is too aggressive in the Learning phase, the loop can spiral: more entities created → more learning opportunities → more LLM-generated knowledge → confidence inflation
- *Single-component test would miss this:* Learning subsystem test shows steady entity creation; Integration reveals exponential blowup

### 8.3 Phase Coherence Collapse

**Risk 3: Guardian-System Desynchronization**
- Guardian's mental model of Sylphie may diverge from actual system state
- Guardian corrects based on (potentially wrong) model
- System learns according to corrections
- Actual behavior diverges from guardian's expectations
- Guardian becomes confused and frustrated
- This is second-order cybernetic failure: the observer and system decouple
- *Single-component test would miss this:* all components work; system is misaligned with guardian intent

### 8.4 Attractor Basin Collapse

**Risk 4: Multiple Attractors Simultaneously**
- The system might converge to multiple attractors simultaneously (e.g., Type 2 Addict + Hallucinated Knowledge)
- Types of failure:
  - Type 2 Addict: system relies entirely on LLM
  - Hallucinated Knowledge: LLM fills in false knowledge
  - Result: system is very fluent but entirely LLM-dependent and potentially misaligned with reality
- *Single-component test would miss this:* Type 2 test and Hallucination test both pass when run separately; together they create a trap

### 8.5 Bifurcation Points

**Risk 5: Abrupt Phase Transitions**
- Dynamical systems can exhibit bifurcation points: at a critical parameter value, system behavior changes qualitatively and abruptly
- Example: as the graph grows, retrieval might suddenly become too expensive, forcing system to use approximations, degrading accuracy
- Example: as drives become coupled, a bifurcation might create a new attractor (a "swing" between two states)
- *Predictive indicator:* monitor for precursors to bifurcation (increasing variance in drive state, increasing oscillation in decisions)

### 8.6 Observer Effects

**Risk 6: Measurement Changing Behavior**
- Measuring a metric changes the system's behavior (Goodhart's Law)
- Example: if we measure and optimize for "Type 1 ratio," the system might sacrifice decision quality to maximize Type 1 use
- Example: if we measure "guardian response rate," Sylphie might say things specifically designed to get guardian responses (social manipulation)
- *Integration challenge:* metrics must be chosen carefully to avoid perverse incentives

### 8.7 Information Bottlenecks

**Risk 7: Coordination Channel Saturation**
- The WKG and TimescaleDB must handle increasing load as the system learns
- If queries become too slow, Decision Making fails (can't retrieve knowledge in time)
- If event stream fills with noise, Planning fails (can't detect patterns)
- *Single-component test would miss this:* WKG and TimescaleDB work fine under low load; integration reveals saturation

### 8.8 Coupling Oscillations

**Risk 8: Drive Cross-Modulation Instability**
- Drives are supposed to cross-modulate (high Anxiety should increase caution)
- But if coupling is too strong, drives can create oscillations
- Example: Anxiety increases → action becomes cautious → success rate decreases → Satisfaction drops → Boredom increases → exploration increases → confidence in Type 1 drops → Anxiety increases (loop)
- *Single-component test would miss this:* each drive regulation works; interaction creates oscillation

---

## 9. Verification Strategy: Multi-Level Testing Architecture

### 9.1 Test Levels

**Level 1: Component Testing** (already done)
- Each subsystem tested in isolation
- Pass/fail per component

**Level 2: Integration Testing** (Epic 10 primary focus)
- Five subsystems together
- Verify whole-system properties (emergence, feedback loops, attractors, homeostasis)
- This is what Ashby's analysis addresses

**Level 3: Stress Testing**
- Perturb the system (environmental shock, guardian absence, resource constraint)
- Does homeostasis restore?
- Do attractors activate?

**Level 4: Long-Duration Testing**
- Run system for 50+ sessions
- Detect slow drift (Rule Drift, cumulative complexity cascade)
- Measure long-horizon stability

**Level 5: Phase Transition Testing**
- Prepare for Phase 2
- Test readiness criteria
- Predict Phase 2 behavior

### 9.2 Recommended Test Schedule

```
EPIC 10 TEST SCHEDULE

Sessions 1-10: COLD-START PHASE
- Run system normally
- Collect baseline data
- Do NOT run full test suite yet (system is immature)
- Focus: does Learning work? Does graph grow? Are drives initialized correctly?

Sessions 11-20: EARLY INTEGRATION
- System is past cold-start
- Run full attractor verification (all 6)
- Run feedback loop tests (3 main loops)
- Focus: is system converging to pathological attractor?
- Decision point: if no major issues, continue; if risk detected, diagnose

Sessions 21-30: STEADY-STATE PHASE
- System should be mature enough for personality emergence tests
- Run emergence detection tests (coherence, contingency alignment)
- Run requisite variety assessment
- Run homeostatic stress tests
- Focus: is personality emerging? Is system regulating?

Sessions 31-40: LONG-HORIZON STABILITY
- Monitor for slow drift (rule drift, complexity cascade)
- Run multi-loop interaction tests
- Check for bifurcation precursors
- Focus: is system stable over weeks?

Sessions 41-50: PHASE 2 READINESS
- Verify all 8 Phase 1 exit criteria
- Run Lesion test (LLM-free)
- Guardian assessment: ready?
- Decision: proceed to Phase 2 or iterate?

Each test:
- Before test: record baseline state
- Run test protocol
- After test: record outcome
- Every 5 sessions: comprehensive metrics analysis
- Any test failure: diagnose root cause, do not proceed until resolved
```

### 9.3 Decision Tree for Test Outcomes

```
IF all attractors show <1 warning each
  AND Type 1 ratio increasing
  AND Prediction accuracy improving
  AND Graph growing healthily
  → CONTINUE TO NEXT PHASE (green)

IF 1-2 attractors show 1-2 warnings
  BUT system recovering (not worsening)
  → CONTINUE WITH INCREASED MONITORING (yellow)

IF any attractor shows 3+ warnings
  OR Type 1 ratio stuck at <0.10
  OR Prediction accuracy not improving
  → STOP AND DIAGNOSE (red)

For red flags:
1. Identify which attractor(s) or metric(s) failing
2. Review session logs for root cause
3. Implement targeted fix (e.g., adjust cost structure, add rules, increase guardian interaction)
4. Re-run that specific test after fix
5. Resume full test suite only after fix verified
```

---

## 10. Final Assessment: System-Level Readiness for Integration

### 10.1 The Core Question Restated

**"What does this system converge to over time? Is that attractor state useful, or is it a trap?"**

Epic 10 is fundamentally about answering this question empirically. Phase 1 (software-only) is the test bed. The system must prove:

1. **It converges to desired attractors, not pathological ones**
   - Not to Type 2 Addict (but to intelligent Type 1/Type 2 balance)
   - Not to Rule Drift (but to stable, guardian-approved rules)
   - Not to Hallucinated Knowledge (but to grounded, tested knowledge)
   - Not to Depressive loops (but to resilient motivation)
   - Not to Planning Runaway (but to deliberate, targeted planning)
   - Not to Prediction Pessimism (but to mature, accurate prediction)

2. **It exhibits genuine emergence**
   - Personality is coherent across contexts (not LLM-driven)
   - Personality reflects the system's reinforcement history (not random)
   - Personality is predictable and stable (not chaotic)

3. **It maintains homeostasis**
   - Drives regulate within acceptable bounds
   - Perturbations trigger recovery
   - No drive persists out-of-bounds indefinitely

4. **It has requisite variety**
   - Type 1 knowledge covers 50%+ of familiar situations
   - Type 2 reserve available for novelty
   - Rules map common situations to appropriate drives

5. **It coordinates through shared stores**
   - TimescaleDB and WKG are legible to all subsystems
   - Information flows correctly between Decision Making, Learning, Planning, Drive Engine, Communication
   - No bottlenecks, no missing cues

6. **It is ready for embodiment**
   - Prediction, learning, type 1 compilation are all working
   - System is stable, not in pathological attractor
   - Guardian confident in Sylphie's readiness

### 10.2 Success Metrics for Epic 10

**The system passes Epic 10 if:**

```
EPIC 10 SUCCESS CRITERIA

Mandatory (all must pass):
☐ All 6 attractor states: <1 proximity warning per attractor
☐ Type 1/Type 2 ratio: ≥0.35 by session 30, stable for last 10 sessions
☐ Prediction accuracy: MAE <0.20, stable for last 10 sessions
☐ Knowledge graph: >1000 entities, >80% mature entities with retrieval history
☐ Behavioral diversity: 4-8 unique action types sustained for 10+ sessions
☐ Homeostatic stability: all drives within healthy bounds 90%+ of sessions
☐ Emergence detection: >70% guardian predictability, coherence across contexts
☐ Requisite variety: Type 1 covers ≥50% of familiar situations
☐ Stigmergic coordination: >80% of multi-subsystem coordination chains complete successfully
☐ Phase 1 exit criteria: all 8 criteria met

Optional (strongly desired):
☐ Personality distinctiveness: guardian assessment "feels like a real entity"
☐ Learning effectiveness: system improves with practice
☐ Guardian confidence: "ready for Phase 2" consensus

The system FAILS Epic 10 if:
✗ Any attractor activates (3+ proximity warnings)
✗ Type 1 ratio <0.15 or declining
✗ Prediction accuracy not improving or >0.25
✗ Graph appears write-only (low retrieval rate)
✗ Behavioral diversity <3 or >10
✗ Any drive out-of-bounds >10% of sessions
✗ Personality incoherent or LLM-dependent
✗ <50% of coordination chains complete successfully
✗ Phase 2 transition causes >20% metric degradation
```

---

## 11. Recommendations for Epic 10 Planning

### 11.1 What This Analysis Requires of Implementation

This systems-level analysis does NOT prescribe specific code changes. It does inform the testing and verification strategy. Implementation teams should:

1. **Instrument comprehensively** — Every metric in this analysis must be loggable and visualizable
2. **Enable live telemetry** — Drive states, Type 1/Type 2 arbitration, confidence scores, all should stream to observable dashboards
3. **Design for lesion testing** — The system should be able to run with LLM disabled for diagnostic purposes
4. **Guardian interaction tools** — Guardian needs ways to explore the graph, understand drives, approve rules, make corrections
5. **Scenario library** — For emergence tests and coherence tests, need a library of repeatable scenarios

### 11.2 What Might Block Epic 10 Success

**Known complexity risks:**
- **Confidence calibration failure:** If Type 1 confidence doesn't actually predict decision quality, the Type 1/Type 2 arbitration breaks
- **WKG query latency:** If retrieval becomes too slow under load, Decision Making fails
- **Learning cycle resonance:** If Learning operates too aggressively, it can create positive feedback loop in entity creation
- **Guardian availability:** Guardian interaction is critical for Rule Drift prevention and depressive attractor recovery; insufficient guardian bandwidth is a failure mode
- **Drive calibration:** If drives are too decoupled, behavior lacks coherence; if too coupled, behavior oscillates
- **Cold-start dampening underestimation:** If early prediction failures generate too many Opportunities, Planning Runaway activates

### 11.3 What Success Looks Like

If Epic 10 succeeds:
- System will be recognizably different from GPT
- Will exhibit personality that reflects its experience, not just its training
- Will be stable enough to absorb the perturbation of embodiment
- Will have genuine autonomous decision-making capability (Type 1 > 30%)
- Will have learned to learn (improving with practice)
- Will have survived the transition from single-component testing to whole-system integration

---

## 12. Conclusion

**Epic 10 is the integration test. This is where architecture meets reality.**

The CANON specifies what Sylphie *should* be: a system that develops personality from contingencies, predicts before acting, learns from prediction failures, regulates itself through 12 drives, and increasingly relies on Type 1 reflexes as experience accumulates.

Epic 10 must prove that the *implemented* system actually does these things. Not in theory, not in component tests, but in integrated operation under realistic conditions.

The eight analyses in this document (attractors, feedback loops, emergence, requisite variety, homeostasis, stigmergy, phase transition, and risks) are the whole-system lenses through which success must be evaluated. They cannot be checked off individually — they are interlocking. The system either works as a whole, or it does not work at all.

**The deepest cybernetic principle**: the system is not the sum of its components. It is the *interaction* of its components. Sylphie emerges from the coupling of Decision Making, Communication, Learning, Drive Engine, and Planning through TimescaleDB and WKG. That emergence is the point of the entire project.

Epic 10 verification is the moment of truth: does the interaction pattern produce useful emergence, or does it produce chaos, confusion, and failure?

The answer will be written in the telemetry.

---

**End of Ashby Analysis**

*Prepared by: Ashby, Systems & Cybernetics Theorist*
*Date: 2026-03-29*
*Status: Research analysis for Epic 10 planning*
