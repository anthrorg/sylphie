# Epic 10: Integration and End-to-End Verification
## Quality Assurance Analysis by Proof

**Status:** PLANNING
**Date:** 2026-03-29
**Scope:** Full-loop integration testing, Phase 1 "must prove" verification, health metrics implementation, lesion test methodology, and attractor state prevention validation.

---

## Executive Summary

Epic 10 is the final integration and verification sprint for Phase 1. It proves that the CANON's architectural vision actually produces the claimed emergent behaviors: genuine learning, Type 1 compilation, personality emergence, and drive-mediated behavior. This is not a feature implementation epic — it is a **verification epic that transforms Phase 1 from architectural theory to empirical proof.**

Proof's analysis covers:
1. Verification strategy for each of the 6 Phase 1 "must prove" items
2. Full-loop integration test architecture
3. Lesion test implementation (3 lesion types)
4. Drift detection baseline establishment
5. Attractor state prevention and early detection
6. Health metrics computation and monitoring
7. Risks, dependencies, and recommended ticket breakdown

---

## Part 1: The Six Phase 1 "Must Prove" Items

The CANON (Phase 1, pages 393-402) identifies six specific claims that Phase 1 must empirically prove. Each requires a distinct verification strategy, metrics to compute, and integration points in the running system.

### 1. The Prediction-Evaluation Loop Produces Genuine Learning

**CANON Claim:** "The prediction-evaluation loop produces genuine learning."

**What This Means:**
- The system makes a **prediction** about what will happen before taking an action
- The system **takes the action**
- The system **observes the outcome**
- The system **compares** prediction to outcome
- The system **updates knowledge** based on the mismatch (prediction error drives learning)
- This cycle repeats, producing increasingly accurate predictions

**Verification Strategy:**

**Level 1: Prediction Event Integrity**
- Verify that every decision is preceded by a prediction event in TimescaleDB
  - Query: `SELECT COUNT(*) FROM events WHERE type='prediction' AND created_at > NOW() - INTERVAL '1 session' GROUP BY decision_id`
  - Expected: 1 prediction per decision (may be multiple alternatives)
  - Failure mode: Decisions without predictions → short-circuit learning loop

- Verify that prediction events include:
  - `decision_context` (episodic memory)
  - `predicted_outcome` (model's expectation)
  - `confidence_score` (how sure the system is)
  - `knowledge_source` (which WKG nodes informed this prediction)

**Level 2: Outcome Event Matching**
- Verify that every prediction has a matching outcome event
  - Query: `SELECT predictions.id, outcomes.id FROM predictions LEFT JOIN outcomes ON predictions.id = outcomes.prediction_id WHERE outcomes.id IS NULL`
  - Expected: Empty result set (every prediction matched)
  - Failure mode: Orphaned predictions → no feedback loop

- Verify outcome events capture:
  - `actual_outcome` (what really happened)
  - `timestamp` (when observation occurred)
  - `observation_source` (sensor, guardian, system log)
  - `prediction_error` (actual - predicted, computed immediately)

**Level 3: Confidence Update Verification**
- Verify that prediction error drives confidence updates via ACT-R formula:
  ```
  min(1.0, base + 0.12 * ln(count) - d * ln(hours + 1))
  ```
  - After outcome event, retrieve the knowledge node that informed the prediction
  - Recompute confidence using the formula
  - Compare against actual confidence stored in WKG
  - Expected: Match within 0.01 (floating-point tolerance)

- Query: For each outcome event in the last session:
  ```
  SELECT
    predictions.knowledge_source,
    outcomes.prediction_error,
    kg_nodes.confidence_before,
    kg_nodes.confidence_after,
    (min(1.0, kg_nodes.base + 0.12 * ln(kg_nodes.retrieval_count) - kg_nodes.decay_rate * ln(hours_elapsed + 1))) as expected_confidence
  FROM predictions
  JOIN outcomes ON predictions.id = outcomes.prediction_id
  JOIN kg_nodes ON predictions.knowledge_source = kg_nodes.id
  WHERE ABS(expected_confidence - kg_nodes.confidence_after) > 0.01
  ```
  - Expected: Empty result set (all confidence updates correct)
  - Failure mode: Confidence updates not computed → no learning signal

**Level 4: Learning Pipeline Integration**
- Verify that high-error predictions (|error| > 0.3) trigger Learning maintenance cycles
  - Query: Pair prediction_error events with maintenance_cycle events
  - Expected: Within 1-2 decision cycles of a high-error prediction, a Learning maintenance cycle occurs
  - The Learning cycle should identify the failed knowledge and refine or replace it

- Verify entity extraction during Learning:
  - Query: Before and after a Learning maintenance cycle, compare WKG node count
  - Expected: New entities created from failed prediction context
  - Monitor entity provenance: failed predictions should produce INFERENCE-tagged nodes and potentially LLM_GENERATED refinements

**Behavioral Metric: Prediction Accuracy Over Time**
- Compute: Mean Absolute Error (MAE) of predictions across rolling windows (every 10 decisions, every session)
  ```
  SELECT
    session_id,
    AVG(ABS(prediction_error)) as MAE,
    STDDEV(ABS(prediction_error)) as error_variance
  FROM outcomes
  GROUP BY session_id
  ORDER BY session_date ASC
  ```
- Expected trend: MAE decreasing initially (cold start noise), then stabilizing as the WKG matures
- Early threshold: MAE should drop from initial ~0.5 to stable ~0.2-0.3 within 20-30 sessions
- Failure mode: MAE flat or increasing → learning loop broken

**Verification Test (Concrete Scenario):**
1. Record baseline: Reset system, first session MAE
2. Session 1-5: Track cumulative prediction error
3. Sessions 5-10: Deliberately introduce a new entity and test predictions about it
4. Expected: MAE on this entity decreases from session 5 to 10
5. Verify: WKG contains new nodes for the entity with confidence > 0.50 and increasing retrieval_count

---

### 2. The Type 1/Type 2 Ratio Shifts Over Time

**CANON Claim:** "The Type 1/Type 2 ratio shifts over time."

**What This Means:**
- Early in development: Most decisions require LLM (Type 2) because the WKG is sparse
- As the WKG grows: More decisions can be made from graph-based reflexes (Type 1)
- Type 1 wins arbitration when confidence > dynamic_threshold
- Type 2 cost (latency, cognitive effort drive pressure) creates evolutionary pressure to graduate behaviors to Type 1
- Result: Type 1/Type 2 ratio increases monotonically over time

**Verification Strategy:**

**Level 1: Decision Path Instrumentation**
- Every decision event in TimescaleDB must record:
  - `arbitration_winner` (Type 1 or Type 2)
  - `type_1_confidence` (highest confidence candidate)
  - `type_1_latency_ms` (graph lookup time)
  - `type_2_latency_ms` (LLM call time)
  - `dynamic_threshold` (confidence threshold at time of decision)
  - `confidence_margin` (type_1_confidence - dynamic_threshold)

**Level 2: Ratio Computation**
- Primary metric: Type 1 / Type 2 ratio per session
  ```
  SELECT
    session_id,
    CAST(COUNT(CASE WHEN arbitration_winner = 'Type1' THEN 1 END) AS FLOAT) / COUNT(*) as type1_ratio
  FROM decisions
  GROUP BY session_id
  ORDER BY session_date ASC
  ```
- Expected: Ratio increasing from ~0.1 (early) to 0.6-0.8 (mature)
- Failure mode: Ratio flat or declining → Type 1 not graduating, possibly due to confidence not accumulating

**Level 3: Type 1 Graduation Verification**
- CANON specifies Type 1 graduation criteria: confidence > 0.80 AND MAE < 0.10 over last 10 uses
  - Track: For each knowledge node that was used in a Type 1 decision
    - Compute: Running MAE over the last 10 uses
    - Compute: Current confidence
    - When both conditions met: Node should be marked "Type 1 Candidate"
    - When used as arbitration winner: Node is "Type 1 Behavior"

  - Query to find nodes that should have graduated:
    ```
    SELECT
      kg_nodes.id,
      kg_nodes.confidence,
      AVG(ABS(outcomes.prediction_error)) as recent_mae
    FROM kg_nodes
    JOIN decision_usage ON kg_nodes.id = decision_usage.node_id
    JOIN outcomes ON decision_usage.decision_id = outcomes.decision_id
    WHERE decision_usage.decision_type = 'arbitration_winner'
    AND kg_nodes.last_retrieval > NOW() - INTERVAL '10 uses'
    GROUP BY kg_nodes.id
    HAVING kg_nodes.confidence > 0.80 AND recent_mae < 0.10
    ```
  - Expected: Growing population of Type 1 nodes over time
  - Verify: These nodes have `type1_graduated_at` timestamp (historical tracking)

**Level 4: Cost Dynamics Verification**
- Verify that Type 2 carries a measurable cost:
  - Query: Latency comparison
    ```
    SELECT
      AVG(CASE WHEN arbitration_winner = 'Type1' THEN type_1_latency_ms ELSE NULL END) as avg_type1_latency,
      AVG(CASE WHEN arbitration_winner = 'Type2' THEN type_2_latency_ms ELSE NULL END) as avg_type2_latency
    ```
  - Expected: Type 2 latency 10-100x higher than Type 1
  - Verify: This latency is reported to Drive Engine as "Cognitive Effort" pressure

  - Query: Drive impact
    ```
    SELECT
      decisions.id,
      decisions.arbitration_winner,
      drive_events.cognitive_effort_delta
    FROM decisions
    JOIN drive_events ON decisions.id = drive_events.decision_id
    WHERE drive_events.cognitive_effort_delta < 0
    ```
  - Expected: Type 2 decisions have negative cognitive_effort_delta more frequently than Type 1
  - Failure mode: No cost differential → no evolutionary pressure for Type 1 graduation

**Behavioral Metric: Type 1 Graduation Rate**
- Secondary metric: Number of new Type 1 graduations per session
  ```
  SELECT
    session_id,
    COUNT(*) as new_type1_graduates
  FROM kg_nodes
  WHERE type1_graduated_at IS NOT NULL
  AND type1_graduated_at > session_start AND type1_graduated_at < session_end
  GROUP BY session_id
  ```
- Expected: Positive trend initially, stabilizing as the system matures (fewer new behaviors to graduate)

**Verification Test (Concrete Scenario):**
1. Setup: Create a known task that requires Type 2 (novel situation)
2. Session 1: Measure decision path, confirm Type 2 wins
3. Sessions 2-10: Repeat the same task multiple times
4. Expected: By session 10, the system should switch to Type 1 for this task
5. Verify:
   - The knowledge node has confidence > 0.80
   - Recent MAE < 0.10
   - Type 1 latency dramatically lower than first session

---

### 3. The Graph Grows Reflecting Real Understanding, Not LLM Regurgitation

**CANON Claim:** "The graph grows in ways that reflect real understanding, not just LLM regurgitation."

**What This Means:**
- The WKG must accumulate **experiential knowledge** (SENSOR + GUARDIAN + INFERENCE provenance)
- LLM_GENERATED knowledge should be a **minority** and should require validation
- The graph should encode patterns that emerge from experience, not just text summaries
- Experiential provenance ratio (non-LLM nodes / total nodes) should increase over time
- LLM_GENERATED nodes should not exceed 0.60 confidence without retrieval-and-use events

**Verification Strategy:**

**Level 1: Provenance Distribution**
- Verify: Every WKG node has exactly one provenance tag
  ```
  SELECT COUNT(*) as nodes_missing_provenance
  FROM kg_nodes
  WHERE provenance IS NULL OR provenance NOT IN ('SENSOR', 'GUARDIAN', 'LLM_GENERATED', 'INFERENCE')
  ```
  - Expected: 0 (all nodes properly tagged)
  - This is a pre-condition for all downstream analysis

- Compute: Experiential provenance ratio
  ```
  SELECT
    session_id,
    CAST(
      COUNT(CASE WHEN provenance IN ('SENSOR', 'GUARDIAN', 'INFERENCE') THEN 1 END) AS FLOAT
    ) / COUNT(*) as experiential_ratio
  FROM kg_nodes
  WHERE created_at < session_end
  GROUP BY session_id
  ORDER BY session_date ASC
  ```
- Expected: Ratio increasing from ~0.4 (early, LLM scaffolding) to 0.7-0.8 (mature)
- Failure mode: Ratio flat or declining → the WKG is being populated by LLM, not grown through experience
- Early warning: If LLM_GENERATED > 0.6 at any session, investigate entity extraction and learning pipeline

**Level 2: LLM_GENERATED Confidence Ceiling Enforcement**
- CANON Standard 3: No LLM_GENERATED node exceeds 0.60 confidence without successful retrieval-and-use
  ```
  SELECT COUNT(*) as violations
  FROM kg_nodes
  WHERE provenance = 'LLM_GENERATED'
  AND confidence > 0.60
  AND retrieval_and_use_count = 0
  ```
  - Expected: 0 violations (confidence ceiling enforced)
  - Failure mode: LLM nodes inflated → Theater risk, hallucinated knowledge risk

- If violations found, query the Learning pipeline:
  - Did the node pass through a successful prediction-outcome cycle?
  - If not, why was confidence updated?
  - This indicates a bug in the confidence update logic

**Level 3: Knowledge Structure Complexity**
- Track: WKG structural metrics as proxies for real understanding
  ```
  SELECT
    session_id,
    COUNT(DISTINCT kg_nodes.id) as node_count,
    COUNT(DISTINCT kg_edges.id) as edge_count,
    CAST(COUNT(DISTINCT kg_edges.id) AS FLOAT) / COUNT(DISTINCT kg_nodes.id) as edge_density,
    COUNT(DISTINCT CASE WHEN kg_edges.relationship_type = 'INSTANCE_OF' THEN 1 END) as schema_edges,
    COUNT(DISTINCT CASE WHEN kg_edges.relationship_type != 'INSTANCE_OF' THEN 1 END) as semantic_edges
  FROM kg_nodes
  LEFT JOIN kg_edges ON kg_nodes.id = kg_edges.source_id
  WHERE kg_nodes.created_at < session_end
  GROUP BY session_id
  ```
- Expected:
  - Node count increasing monotonically (new entities from experience)
  - Edge density increasing (more connections between concepts)
  - Ratio of semantic edges (not schema) increasing (real relationships, not just categorization)

- This metric captures: The graph is not just a bag of facts; it is developing internal structure

**Level 4: Contradiction Detection as Learning Signal**
- CANON (Learning subsystem): "Contradictions are developmental catalysts, not errors to suppress"
- Verify: The Learning pipeline detects contradictions
  ```
  SELECT COUNT(*) as contradiction_count
  FROM learning_events
  WHERE event_type = 'contradiction_detected'
  AND session_id = ?
  ```
- Expected: At least 1-2 contradictions per session early on (indicates active learning)
- When contradiction occurs:
  - Verify: Both conflicting nodes remain in the WKG with high provenance tags
  - Verify: A LEARNING_CONTEXT edge links them for later resolution
  - This prevents the system from silently "correcting" itself and losing information

**Behavioral Metric: Experiential vs. LLM Knowledge Ratio**
- Dashboard should plot:
  ```
  SELECT
    session_id,
    CAST(COUNT(CASE WHEN provenance IN ('SENSOR', 'GUARDIAN', 'INFERENCE') THEN 1 END) AS FLOAT) / COUNT(*) as experiential_ratio,
    CAST(COUNT(CASE WHEN provenance = 'LLM_GENERATED' THEN 1 END) AS FLOAT) / COUNT(*) as llm_ratio
  FROM kg_nodes
  WHERE created_at < session_end
  GROUP BY session_id
  ```
- Healthy trend: experiential_ratio increasing, llm_ratio decreasing

**Verification Test (Concrete Scenario):**
1. Setup: Create a guardian teaching event (e.g., "X is a kind of Y")
2. Verify: Node X is created with GUARDIAN provenance at confidence 0.60
3. Setup: Create a sensor observation that uses X
4. Verify: X's confidence increases via ACT-R, remains below ceiling until retrieval-and-use
5. Setup: Deliberately provide contradictory information (e.g., "X is a kind of Z")
6. Verify:
   - Both nodes remain in WKG
   - Contradiction is flagged as LEARNING_CONTEXT
   - System does not auto-resolve (guardian or higher-level reasoning required)

---

### 4. Personality Emerges from Contingencies

**CANON Claim:** "Personality emerges from contingencies, not targets."

**What This Means:**
- Sylphie has no personality trait targets (e.g., "be 80% curious")
- Personality is the observable behavioral pattern produced by reinforcement history
- The 12 drives and their contingencies shape behavior; personality is the emergent consequence
- A "curious" Sylphie is one where novelty-seeking reliably produces drive relief
- The trajectory (how behavior changes) is the personality

**Verification Strategy:**

**Level 1: Behavioral Contingency Firing Verification**
- For each CANON behavioral contingency, verify it fires as specified:

**A. Satisfaction Habituation Curve** (CANON page 286-294)
- Repeated execution of the same successful action should produce diminishing returns:
  - 1st success: +0.20 Satisfaction
  - 2nd consecutive: +0.15
  - 3rd: +0.10
  - 4th: +0.05
  - 5th+: +0.02

- Query: Find repeated successful actions
  ```
  SELECT
    decisions.id,
    decisions.action,
    ROW_NUMBER() OVER (PARTITION BY decisions.action ORDER BY decisions.created_at ASC) as repetition_number,
    drive_events.satisfaction_delta,
    CASE
      WHEN repetition_number = 1 THEN 0.20
      WHEN repetition_number = 2 THEN 0.15
      WHEN repetition_number = 3 THEN 0.10
      WHEN repetition_number = 4 THEN 0.05
      ELSE 0.02
    END as expected_delta
  FROM decisions
  JOIN outcomes ON decisions.id = outcomes.decision_id
  JOIN drive_events ON decisions.id = drive_events.decision_id
  WHERE outcomes.outcome_success = true
  AND drive_events.satisfaction_delta > 0
  ```
- Expected: satisfaction_delta matches expected_delta (within ±0.02 tolerance)
- Failure mode: Flat satisfaction deltas → no habituation → behavioral repetition → personality narrowing

**B. Anxiety Amplification** (CANON page 296-297)
- Actions under high Anxiety (>0.7) with negative outcomes get 1.5x confidence reduction
  ```
  SELECT
    decisions.id,
    drive_events.anxiety_before,
    outcomes.outcome_success,
    kg_nodes.confidence_before,
    kg_nodes.confidence_after,
    kg_nodes.confidence_before - kg_nodes.confidence_after as confidence_delta
  FROM decisions
  JOIN drive_events ON decisions.id = drive_events.decision_id
  JOIN outcomes ON decisions.id = outcomes.decision_id
  JOIN kg_nodes ON decisions.knowledge_source = kg_nodes.id
  WHERE drive_events.anxiety_before > 0.7
  AND outcomes.outcome_success = false
  ```
- Expected: confidence_delta when anxiety > 0.7 is ~1.5x larger than normal negative prediction errors
- This produces cautious-but-active behavior: the system acts under uncertainty but more carefully

**C. Guilt Repair Contingency** (CANON page 299-300)
- Guilt relief requires BOTH acknowledgment AND behavioral change
  - Acknowledgment alone: Guilt -0.10
  - Behavioral change alone: Guilt -0.15
  - Both: Guilt -0.30

  - Query: Find guardian correction events
    ```
    SELECT
      guardian_events.id,
      guardian_events.event_type, -- CORRECTION, ACKNOWLEDGMENT, BEHAVIORAL_CHANGE
      drive_events.guilt_delta
    FROM guardian_events
    JOIN drive_events ON guardian_events.decision_id = drive_events.decision_id
    WHERE guardian_events.event_type IN ('CORRECTION', 'ACKNOWLEDGMENT', 'BEHAVIORAL_CHANGE')
    ```
  - Expected: guilt_delta values match the contingency structure
  - Verify: Full repair (both factors) produces larger relief than either alone

**D. Social Comment Quality** (CANON page 302-303)
- Guardian response within 30s to Sylphie-initiated comment → extra reinforcement
  - Social -0.15 + Satisfaction +0.10 (combined effect)

  - Query: Find Sylphie-initiated comments with guardian responses
    ```
    SELECT
      communication_events.id as comment_id,
      communication_events.created_at,
      guardian_responses.created_at as response_time,
      EXTRACT(EPOCH FROM (guardian_responses.created_at - communication_events.created_at)) / 60 as response_latency_minutes,
      drive_events.social_delta,
      drive_events.satisfaction_delta
    FROM communication_events
    LEFT JOIN guardian_responses ON communication_events.id = guardian_responses.comment_id
    LEFT JOIN drive_events ON guardian_responses.id = drive_events.event_id
    WHERE communication_events.initiator = 'Sylphie'
    ```
  - Expected: When response_latency < 0.5 minutes, social_delta + satisfaction_delta ≈ -0.15 + 0.10
  - This shapes Sylphie toward saying things worth responding to

**E. Curiosity Information Gain** (CANON page 305-306)
- Curiosity relief proportional to actual information gain (new nodes, confidence increases, resolved errors)

  - Query: Measure information gain per exploration action
    ```
    SELECT
      decisions.id,
      decisions.action_type, -- EXPLORE, INVESTIGATE
      COUNT(DISTINCT CASE WHEN kg_nodes.created_at > decisions.created_at THEN kg_nodes.id END) as new_nodes,
      SUM(CASE WHEN kg_nodes.confidence_delta > 0 THEN kg_nodes.confidence_delta ELSE 0 END) as confidence_gains,
      AVG(ABS(outcomes.prediction_error)) as information_resolving_power
    FROM decisions
    LEFT JOIN outcomes ON decisions.id = outcomes.decision_id
    LEFT JOIN kg_nodes ON kg_nodes.created_at > decisions.created_at AND kg_nodes.created_at < DATE_ADD(decisions.created_at, INTERVAL 1 MINUTE)
    WHERE decisions.action_type IN ('EXPLORE', 'INVESTIGATE')
    GROUP BY decisions.id
    ```
  - Expected: Curiosity delta proportional to (new_nodes + confidence_gains)
  - Failure mode: Curiosity relief flat regardless of information gain → no learning-driven exploration

**Level 2: Behavioral Diversity Index**
- Primary metric: Unique action types per rolling 20-action window
  ```
  SELECT
    session_id,
    COUNT(DISTINCT action_type) as unique_action_types,
    (ROW_NUMBER() OVER (ORDER BY created_at ASC) % 20) as window_num
  FROM decisions
  WHERE session_id = ?
  GROUP BY window_num
  ```
- Expected: Stable at 4-8 unique types (CANON page 316)
- Failure mode: Declining diversity (habituation working too hard) or erratic diversity (instability)

**Level 3: Personality Trajectory Mapping**
- Rather than a trait profile, plot behavior over time:
  - X-axis: Session number
  - Y-axis: % of decisions using each action type
  - Expected: Smooth curves showing behavioral shifts as drives change and contingencies fire
  - Example: If Curiosity is high, exploration actions spike; if Boredom is high, novelty-seeking actions spike

- This is qualitative but essential: the **trajectory** should be recognizable as a developing personality, not random noise

**Behavioral Metric: Drive Relief Efficiency**
- Secondary metric: Time (in decision cycles) from drive pressure to relief
  ```
  SELECT
    drive_name,
    AVG(cycles_to_relief) as mean_resolution_time,
    STDDEV(cycles_to_relief) as resolution_variance
  FROM drive_cycles
  WHERE drive_value > 0.6 -- elevated
  GROUP BY drive_name
  ```
- Expected: Drives resolve within 5-15 cycles on average (CANON metric: "Mean drive resolution time decreasing over time")
- Healthy trend: Resolution time decreasing (the system gets more efficient at satisfying its drives)

**Verification Test (Concrete Scenario):**
1. Setup: Record baseline satisfaction curve for a repeated action
   - Expected: +0.20, +0.15, +0.10, +0.05, +0.02 on repetitions 1-5
2. Verify: After 5 repetitions, satisfaction for this action drops below threshold
3. Expected result: The system shifts to a different action (behavioral diversity)
4. Guardian feedback: If the system shifts behaviors, it's showing personality development

---

### 5. The Planning Subsystem Creates Useful Procedures

**CANON Claim:** "The Planning subsystem creates useful procedures."

**What This Means:**
- The Planning subsystem is triggered by Opportunities (detected by Drive Engine)
- Plans are procedures: sequences of steps that (if successful) resolve an Opportunity
- Plans are not permanent — they follow ACT-R confidence dynamics
- A procedure is "useful" if:
  - It is created in response to a real pattern (not noise)
  - It succeeds more often than it fails
  - It reduces drive pressure more efficiently than alternatives
  - It is actually used by Decision Making (Type 1 graduation candidate)

**Verification Strategy:**

**Level 1: Opportunity Detection Verification**
- Verify: The Drive Engine creates Opportunities correctly
  - Query: Find prediction failures and Opportunity creation
    ```
    SELECT
      outcomes.prediction_error,
      opportunities.created_at,
      opportunities.error_magnitude
    FROM outcomes
    JOIN opportunities ON outcomes.id = opportunities.triggering_event_id
    WHERE ABS(outcomes.prediction_error) > 0.3
    ```
  - Expected: For prediction errors > 0.3, an Opportunity is created within 1 decision cycle
  - Failure mode: No Opportunities → Planning subsystem never triggered

- Verify: Opportunities track pattern frequency
  ```
  SELECT
    opportunities.id,
    COUNT(*) as occurrence_count
  FROM opportunities
  JOIN opportunity_occurrences ON opportunities.id = opportunity_occurrences.opportunity_id
  GROUP BY opportunities.id
  ```
  - Expected: Opportunities marked for planning have occurrence_count >= 3 (recurring pattern, not one-off)
  - Non-recurring but high-impact Opportunities may also be marked (CANON page 147-150)

**Level 2: Plan Creation Verification**
- Verify: Plans are created from Opportunities
  ```
  SELECT
    opportunities.id,
    plans.id,
    plans.created_at,
    EXTRACT(EPOCH FROM (plans.created_at - opportunities.created_at)) / 60 as creation_latency_minutes
  FROM opportunities
  LEFT JOIN plans ON opportunities.id = plans.opportunity_id
  ```
  - Expected: For each prioritized Opportunity, a Plan is created within 1-5 decision cycles
  - Failure mode: Opportunities without Plans → Planning pipeline broken

- Verify: Plan validation by LLM Constraint Engine
  ```
  SELECT
    plans.id,
    plans.validation_status, -- PASSED, FAILED, REJECTED
    plans.validation_feedback
  FROM plans
  ```
  - Expected: Plans are validated before execution (CANON page 179)
  - Failed/Rejected plans should loop back to re-propose (not discarded)

**Level 3: Plan Execution and Feedback**
- Verify: Plans are used in Decision Making
  ```
  SELECT
    plans.id,
    COUNT(*) as execution_count
  FROM plans
  JOIN decision_usage ON plans.id = decision_usage.plan_id
  GROUP BY plans.id
  ```
  - Expected: Created Plans are actually used (execution_count > 0)
  - Failure mode: Plans created but never used → Planning output disconnected from Decision Making

- Verify: Plan outcomes are recorded and evaluated
  ```
  SELECT
    plans.id,
    AVG(CASE WHEN plan_outcomes.success = true THEN 1 ELSE 0 END) as success_rate,
    COUNT(*) as execution_count
  FROM plans
  LEFT JOIN plan_outcomes ON plans.id = plan_outcomes.plan_id
  GROUP BY plans.id
  ```
  - Expected: Successful Plans (success_rate > 0.6) are used more frequently
  - Plans with low success_rate should have reduced confidence (ACT-R dynamics)

**Level 4: Procedure Usefulness Metrics**
- A procedure is useful if it passes three criteria:

  **A. Success Rate > Baseline**
    ```
    SELECT
      plans.id,
      CAST(SUM(CASE WHEN plan_outcomes.success = true THEN 1 ELSE 0 END) AS FLOAT) / COUNT(*) as success_rate,
      (SELECT AVG(CASE WHEN outcomes.outcome_success = true THEN 1 ELSE 0 END) FROM outcomes) as baseline_success_rate
    FROM plans
    LEFT JOIN plan_outcomes ON plans.id = plan_outcomes.plan_id
    GROUP BY plans.id
    HAVING success_rate > baseline_success_rate
    ```
  - Expected: Useful Plans exceed baseline success rate
  - Baseline = "what's the system's baseline success rate without this Plan?"

  **B. Drive Pressure Reduction**
    ```
    SELECT
      plans.id,
      AVG(drive_events_before.drive_value) as avg_pressure_before,
      AVG(drive_events_after.drive_value) as avg_pressure_after,
      (AVG(drive_events_before.drive_value) - AVG(drive_events_after.drive_value)) as pressure_reduction
    FROM plans
    JOIN plan_executions ON plans.id = plan_executions.plan_id
    JOIN drive_events drive_events_before ON plan_executions.created_at = drive_events_before.tick_time
    JOIN drive_events drive_events_after ON (plan_executions.created_at + INTERVAL '1 cycle') = drive_events_after.tick_time
    GROUP BY plans.id
    ```
  - Expected: Useful Plans reduce relevant drive pressure
  - Failure mode: Plans that don't change drive state → not fulfilling their purpose

  **C. Efficiency vs. Alternatives**
    ```
    SELECT
      plans.id,
      AVG(plan_executions.execution_time) as plan_latency,
      AVG(plan_executions.resource_cost) as plan_cost,
      (SELECT AVG(EXTRACT(EPOCH FROM outcomes.created_at - decisions.created_at)) FROM outcomes JOIN decisions ON outcomes.decision_id = decisions.id WHERE action != plans.action) as alternative_latency
    FROM plans
    LEFT JOIN plan_executions ON plans.id = plan_executions.plan_id
    GROUP BY plans.id
    ```
  - Expected: Plans achieve their goal more efficiently (lower latency or resource cost) than ad-hoc approaches

**Level 5: Known Attractor: Planning Runaway Prevention**
- CANON warns: "Many prediction failures → many Opportunities → many Plans → resource exhaustion" (page 366)
- Verify: Planning pipeline has safeguards
  ```
  SELECT
    DATE(creation_time) as date,
    COUNT(*) as opportunity_count,
    COUNT(CASE WHEN status = 'planned' THEN 1 END) as planned_count,
    COUNT(CASE WHEN status = 'created' THEN 1 END) as created_plan_count
  FROM opportunities
  GROUP BY DATE(creation_time)
  ```
  - Expected: Opportunities decay in priority if not resolved (CANON page 184)
  - Failure mode: Unbounded queue growth → resource exhaustion

  - Verify: Rate limiting on Planning pipeline
    ```
    SELECT
      COUNT(*) as plans_per_session
    FROM plans
    GROUP BY session_id
    ```
  - Expected: Reasonable ceiling on Plans/session (e.g., < 10)
  - Failure mode: Exponential plan creation → system thrashing

**Behavioral Metric: Plan Adoption Rate**
- Percentage of created Plans that are used at least 3 times
  ```
  SELECT
    session_id,
    CAST(COUNT(CASE WHEN execution_count >= 3 THEN 1 END) AS FLOAT) / COUNT(*) as adoption_rate
  FROM (
    SELECT
      plans.session_id,
      plans.id,
      COUNT(*) as execution_count
    FROM plans
    LEFT JOIN plan_executions ON plans.id = plan_executions.plan_id
    GROUP BY plans.id
  ) t
  GROUP BY session_id
  ```
- Expected: Adoption rate increasing over time (Plans getting better)

**Verification Test (Concrete Scenario):**
1. Setup: Create a scenario where the system encounters a repeated prediction failure (e.g., "I predict X will happen, but Y always happens instead")
2. Verify: After 3+ occurrences, an Opportunity is created
3. Verify: Planning subsystem creates a Plan to address this (e.g., "When X is predicted, do Z instead")
4. Verify: The Plan is validated by LLM
5. Verify: The Plan is executed in subsequent decisions
6. Verify: The Plan's success rate > baseline
7. Verify: The Plan reduces the relevant drive pressure

---

### 6. Drive Dynamics Produce Recognizable Behavioral Patterns

**CANON Claim:** "Drive dynamics produce recognizable behavioral patterns."

**What This Means:**
- The 12 drives (4 core + 8 complement) are not trait labels; they are pressure systems
- When drives cross certain thresholds, the system produces characteristic behaviors
- An observer (the guardian) should be able to recognize "the system is in high curiosity mode" by its actions
- Behavioral patterns are predictable from drive state
- Personality emerges as the stable, recognizable pattern of drive cross-modulation

**Verification Strategy:**

**Level 1: Drive State Recording and Integrity**
- Verify: Every drive tick is recorded in TimescaleDB with complete state
  ```
  SELECT
    drive_ticks.id,
    drive_ticks.system_health,
    drive_ticks.moral_valence,
    drive_ticks.integrity,
    drive_ticks.cognitive_awareness,
    drive_ticks.guilt,
    drive_ticks.curiosity,
    drive_ticks.boredom,
    drive_ticks.anxiety,
    drive_ticks.satisfaction,
    drive_ticks.sadness,
    drive_ticks.information_integrity,
    drive_ticks.social
  FROM drive_ticks
  ```
  - Expected: All 12 drives present in every tick
  - Verify: Values are bounded [0.0, 1.0]

**Level 2: Drive Cross-Modulation Patterns**
- CANON Appendix A.1 (reserved for detailed Drive Cross-Modulation Rules) specifies how drives interact
- Until detailed spec exists, verify basic patterns:
  - **Core drives provide constraint:**
    - If System Health is very low (< 0.2), other drives should be dampened (system is in crisis mode)
    - If Moral Valence is low, Guilt should be elevated

  - **Complement drives provide motivation:**
    - Curiosity should bias Decision Making toward exploration actions
    - Boredom should increase when repetition is high
    - Anxiety should increase when prediction errors are high
    - Satisfaction should decrease with repeated action (habituation curve)

  - Query to verify Core-Complement interaction:
    ```
    SELECT
      drive_ticks.id,
      drive_ticks.system_health,
      drive_ticks.moral_valence,
      drive_ticks.integrity,
      drive_ticks.guilt,
      CASE
        WHEN drive_ticks.moral_valence < 0.3 THEN 'Guilt should be elevated'
        WHEN drive_ticks.moral_valence > 0.7 THEN 'Guilt should be suppressed'
      END as expected_guilt_effect
    FROM drive_ticks
    ```
  - This is a framework for future detailed validation

**Level 3: Behavioral Response to Drive State**
- For each drive, define the expected behavior range:

  **Curiosity-Driven Behavior**
    ```
    SELECT
      drive_ticks.id,
      drive_ticks.curiosity,
      decisions.action_type,
      CASE
        WHEN drive_ticks.curiosity > 0.7 THEN 'Should explore/investigate'
        WHEN drive_ticks.curiosity < 0.3 THEN 'Should focus on known paths'
      END as expected_action_bias
    FROM drive_ticks
    JOIN decisions ON drive_ticks.id = decisions.drive_tick_id
    ```
  - Expected: When curiosity > 0.7, exploration actions are more frequent
  - Quantify: Correlation coefficient between curiosity level and exploration action frequency

  **Anxiety-Driven Behavior**
    ```
    SELECT
      drive_ticks.id,
      drive_ticks.anxiety,
      decisions.confidence_threshold_at_time,
      decisions.arbitration_winner
    FROM drive_ticks
    JOIN decisions ON drive_ticks.id = decisions.drive_tick_id
    ```
  - Expected: When anxiety > 0.7, confidence threshold increases (more cautious)
  - CANON (page 296): Under high anxiety with negative outcomes, confidence reduction is 1.5x

  **Boredom-Driven Behavior**
    ```
    SELECT
      drive_ticks.boredom,
      COUNT(DISTINCT decision.action_type) as action_diversity
    FROM drive_ticks
    JOIN decisions ON drive_ticks.id = decisions.drive_tick_id
    GROUP BY drive_ticks.boredom
    ```
  - Expected: When boredom is high, action diversity increases (seeking novelty)

  **Satisfaction-Driven Behavior**
    ```
    SELECT
      drive_ticks.satisfaction,
      COUNT(*) as action_frequency
    FROM drive_ticks
    JOIN decisions ON drive_ticks.id = decisions.drive_tick_id
    GROUP BY drive_ticks.satisfaction
    ```
  - Expected: When satisfaction is low, action frequency increases (seeking relief)

**Level 4: Guardian Recognition Test**
- Qualitative but essential: Can a human observer recognize drive-driven behavior patterns?
- Test procedure:
  1. Record 10 minutes of system behavior (Decision Making events, drive state history)
  2. Ask guardian: "What was the system motivated to do? What patterns do you see?"
  3. Compare guardian observation against actual drive state history
  4. Expected: High correspondence (guardian recognizes the patterns)
  - Failure mode: Guardian cannot recognize patterns → drives and behaviors are decoupled or noisy

**Level 5: Behavioral Pattern Stability Over Time**
- Track: For each drive state range, what is the median behavior?
  ```
  SELECT
    CASE
      WHEN drive_ticks.curiosity > 0.7 THEN 'High Curiosity'
      WHEN drive_ticks.curiosity > 0.4 THEN 'Moderate Curiosity'
      ELSE 'Low Curiosity'
    END as curiosity_state,
    decisions.action_type,
    COUNT(*) as frequency
  FROM drive_ticks
  JOIN decisions ON drive_ticks.id = decisions.drive_tick_id
  GROUP BY curiosity_state, decisions.action_type
  ORDER BY curiosity_state, frequency DESC
  ```
- Expected: For each drive state, the most frequent action type is consistent and recognizable
- Failure mode: Noisy/random mappings → drives not producing consistent behavior

**Behavioral Metric: Drive Pattern Predictability**
- For each drive, compute correlation between drive value and corresponding behavior:
  ```
  CORR(curiosity_level, exploration_action_frequency) as curiosity_behavior_correlation
  ```
- Expected: Correlations > 0.5 for all drives (significant relationship)
- Failure mode: Correlations < 0.3 → drives not driving behavior

**Verification Test (Concrete Scenario):**
1. Setup: Record baseline drive state and behavioral distribution
2. Artificially elevate Curiosity drive (simulate by setting curiosity > 0.8)
3. Expected: Next 10 decisions should be exploration-biased
4. Verify: Exploration actions increase from baseline
5. Guardian feedback: "Does it look like the system is curious?"
6. Reset Curiosity to low (< 0.2)
7. Expected: Next 10 decisions should focus on known, high-confidence actions
8. Guardian feedback: "Does it look like the system is focused/satisfied?"

---

## Part 2: Full-Loop Integration Test Architecture

The 6 "must prove" items are **individually verifiable**. But Sylphie's value is in the **integrated system**. A full-loop integration test verifies that all five subsystems communicate correctly and that data flows end-to-end.

### Integration Test Flow (Cold Start → Mature)

**Phase 0: System Initialization**
- All databases online: Neo4j, TimescaleDB, PostgreSQL
- All subsystems initialized:
  - Decision Making: episodic memory ready, arbitration logic loaded
  - Communication: input parser ready, LLM context assembled, TTS/chatbox ready
  - Learning: maintenance cycle triggered by Cognitive Awareness, ready to extract entities
  - Drive Engine: isolated process running, drive rules loaded, ready to tick
  - Planning: opportunity queue ready, LLM Constraint Engine ready
- Expected: Type-check passes, app boots without errors, all databases reachable

**Phase 1: Cold Start (Session 1)**
- Guardian: "Hello, who are you?"
- System should:
  1. Communication subsystem parses input
  2. Decision Making generates prediction: "Guardian is asking for identification. I should respond with my name."
  3. No high-confidence Type 1 candidate (WKG sparse)
  4. Type 2 wins: LLM generates response
  5. LLM context includes:
     - Episodic memory (this is the first message)
     - Drive state (baseline)
     - WKG (mostly empty)
  6. Response: "I am Sylphie, an AI companion learning from experience."
  7. TimescaleDB records:
     - Input event (guardian input)
     - Prediction event (before response)
     - Response event (output)
     - Drive event (current state)
  8. Learning subsystem extracts entities:
     - Entity: "Sylphie" (name)
     - Entity: "AI companion" (category)
     - Entity: "Guardian" (Person_Jim)
     - Edge: Sylphie INSTANCE_OF AI_companion
     - Edge: Sylphie BELONGS_TO Guardian
  9. All new nodes have LLM_GENERATED provenance, base confidence 0.35
  10. Drive Engine ticks: System Health normal, Social activated by interaction

**Phase 2: Repetition and Learning (Sessions 2-5)**
- Guardian asks similar questions (to enable prediction-evaluation loop)
- System should:
  1. Make predictions based on sparse WKG
  2. Predictions likely fail (MAE ~0.5)
  3. Learning extracts more entities, refines edges
  4. WKG grows, experiential provenance increases (edges validated by outcome)
  5. Type 1/Type 2 ratio slowly increases (new high-confidence nodes available)
  6. Drives show early patterns (Curiosity about Guardian, Social in response to attention)

**Phase 3: Maturation (Sessions 6-20)**
- System has handled many similar scenarios
- System should:
  1. Show Type 1 wins on familiar topics (>50% Type 1 ratio)
  2. Predictions improving (MAE ~0.3)
  3. WKG structured: entities, schema, inference edges
  4. Drives show stabilized patterns
  5. Planning subsystem created initial Procedures (if prediction failures triggered Opportunities)
  6. Drive contingencies firing: satisfaction declining with repetition, anxiety rising with prediction errors

**Phase 4: Optimization (Sessions 21+)**
- System is well-trained on observed domain
- System should:
  1. Type 1 ratio stabilizing (~60-70%)
  2. Predictions stable (MAE ~0.2)
  3. Behavioral diversity maintained (4-8 action types per window)
  4. Personality recognizable (drive-driven behavior patterns consistent)

### Integration Test Checklist (Per Session)

**Subsystem 1: Decision Making**
- [ ] Episodic memory encodes every input
- [ ] Inner Monologue generates predictions
- [ ] Type 1 / Type 2 arbitration occurs
- [ ] Winner is executed
- [ ] Outcome is recorded

**Subsystem 2: Communication**
- [ ] Input parsed correctly
- [ ] WKG context retrieved for response generation
- [ ] Person_Guardian evaluated (other modeling)
- [ ] Drive state injected into LLM context (avoid Theater)
- [ ] Response generated and output
- [ ] No console errors during I/O

**Subsystem 3: Learning**
- [ ] Maintenance cycle triggered (pressure or timer)
- [ ] Learnable events identified (has_learnable=true)
- [ ] Entities extracted (max 5 per cycle)
- [ ] Edges created with correct provenance
- [ ] Contradiction detection fires on conflicts
- [ ] WKG grown (new nodes/edges visible in Neo4j)

**Subsystem 4: Drive Engine**
- [ ] Isolated process running without errors
- [ ] Drive tick computed (all 12 drives present)
- [ ] Drive values bounded [0.0, 1.0]
- [ ] Rules applied correctly
- [ ] Opportunities created for high-error predictions
- [ ] Opportunity priority queue maintained (decay active)

**Subsystem 5: Planning**
- [ ] Opportunities trigger planning research
- [ ] Plans proposed, validated, created
- [ ] Plans used in Decision Making
- [ ] Plan outcomes recorded
- [ ] High-performing Plans graduate confidence

**Data Stores**
- [ ] TimescaleDB: All events recorded with correct types and fields
- [ ] Neo4j: WKG updated with new nodes/edges
- [ ] PostgreSQL: Drive rules intact, no unauthorized changes
- [ ] Provenance: All WKG nodes/edges have provenance tag

### Integration Test Automation

Run integration tests as:
1. **Startup verification** (before any tests)
   ```bash
   npm run type:check  # TypeScript
   npm run start:dev   # Boot system
   sleep 5             # Wait for all subsystems
   curl http://localhost:3000  # UI responsive?
   curl http://localhost:7474  # Neo4j responsive?
   npx jest integration.test.ts  # Run integration suite
   ```

2. **Per-session integration test**
   - Guardian interaction script (5-10 turns)
   - Each turn verifies subsystem outputs
   - Queries databases to confirm data flow
   - Generates pass/fail report

3. **Post-session verification**
   - Type-check system
   - Query all 5 subsystems for errors
   - Verify no constraint violations
   - Snapshot database state for regression detection

---

## Part 3: Lesion Test Methodology

The lesion test is Sylphie's ground truth for development. It reveals what the system knows through its own accumulated experience vs. what it relies on the LLM for.

### Lesion Type 1: Remove LLM Access

**What It Tests:** Type 1 autonomy. How much can the system handle through graph-based reflexes alone?

**Implementation:**
```typescript
// In decision-making.service.ts, add lesion control:
async arbitrate(situation: Situation): Promise<Action> {
  const type1Candidates = await this.retrieveGraphCandidates(situation);
  const type1Winner = this.selectHighestConfidence(type1Candidates);

  // LESION TEST: if LLM disabled, Type 2 cannot be used
  if (this.config.lesion.llm_disabled && !type1Winner) {
    return this.signalIncomprehension(); // Shrug Imperative
  }

  if (!type1Winner || type1Winner.confidence < this.threshold) {
    if (this.config.lesion.llm_disabled) {
      return this.signalIncomprehension();
    }
    const type2Result = await this.generateType2(situation);
    return type2Result;
  }

  return type1Winner;
}
```

**Measurement:**
- Disable Claude API calls, force all decisions Type 1
- Run 10 standard interactions
- Measure:
  - Percentage of interactions handled without error
  - Percentage needing `signalIncomprehension` (Shrug Imperative)
  - Quality of Type-1-only responses (guardian rating: 1-5)

**Expected Results by Phase:**
- Cold start: Helpless (< 10% success)
- Sessions 5-10: Degraded but functional (40-60% success)
- Sessions 20+: Handles most situations (80%+ success)

**Failure Mode:** If system is permanently helpless, Type 1 graduation is not working.

### Lesion Type 2: Remove WKG Access

**What It Tests:** Dependence on accumulated knowledge. How much does LLM provide vs. WKG?

**Implementation:**
```typescript
// In knowledge.service.ts, add lesion control:
async queryWKG(query: string): Promise<KnowledgeResult> {
  if (this.config.lesion.wkg_disabled) {
    return { nodes: [], edges: [] }; // Empty graph
  }
  return await this.neo4j.run(query);
}
```

**Measurement:**
- Disable WKG queries, force all decisions to rely on LLM training
- Run 10 standard interactions
- Measure:
  - Response quality with zero WKG context (guardian rating)
  - LLM context size (much larger with WKG, reveals dependency)
  - Prediction accuracy without WKG grounding

**Expected Results:**
- System should still generate coherent responses (LLM's training is capable)
- BUT: Responses should be generic, not personalized to guardian/context
- Prediction accuracy should drop (no learned patterns)

**Diagnostic Value:** If response quality doesn't degrade significantly, the WKG is not being used effectively.

### Lesion Type 3: Remove Drive Engine

**What It Tests:** Personality dependence on drives. Is behavior actually drive-motivated?

**Implementation:**
```typescript
// In drive-engine.service.ts, add lesion control:
async computeNextDriveState(): Promise<DriveState> {
  if (this.config.lesion.drive_engine_disabled) {
    return this.neutralDriveState(); // All drives at 0.5 (neutral)
  }
  return await this.computeFromRules();
}
```

**Measurement:**
- Disable Drive Engine (all drives at neutral 0.5)
- Run 10 standard interactions
- Measure:
  - Behavioral diversity (still varies?)
  - Emotional expressions (does system still claim emotions?)
  - Personality consistency (is there a coherent pattern?)

**Expected Results:**
- Behavioral diversity should decrease (no pressure driving exploration/exploitation balance)
- Emotional expressions should still occur (LLM can generate them) **BUT violate Theater Prohibition**
- Personality should be flat/generic (all drive-driven personality gone)

**Critical Check - Theater Prohibition:**
- With drive engine disabled, if system produces emotional expression, this violates CANON
- Should be caught by Theater Prohibition verification

**Diagnostic Value:** If personality doesn't change, drives are not actually driving behavior (decoupled system).

### Lesion Test Comparison Matrix

After running all three lesions, create a comparison matrix:

| Capability | No Lesion | No LLM | No WKG | No Drives |
|------------|-----------|--------|--------|-----------|
| Interaction success % | 95% | 80% | 85% | 70% |
| Avg response quality | 4.5/5 | 3.5/5 | 3.0/5 | 2.5/5 |
| Prediction MAE | 0.25 | 0.45 | 0.60 | 0.40 |
| Behavior diversity | 6 types | 4 types | 5 types | 2 types |
| Personality consistency | High | High | Med | Low |
| Theater violations | 0 | 0 | 0 | >0 |

**Interpretation:**
- **Type 1 maturity:** Deficit from "No LLM" lesion should be small (healthy) or large (underdeveloped)
- **WKG relevance:** Deficit from "No WKG" lesion should be moderate (knowledge being used)
- **Drive integration:** Deficit from "No Drives" lesion should be large AND include Theater violations (bad sign)

### Lesion Test Schedule

- **Baseline (cold start):** After system boots, before any interactions
- **Early (session 5):** After initial learning
- **Mid (session 15):** During maturation
- **Late (session 25):** After optimization
- **Post-Phase:** Final assessment before Phase 2

Each lesion run should be documented with results saved to TimescaleDB:
```sql
INSERT INTO lesion_test_results (
  lesion_type, session_id, interaction_success_rate,
  response_quality_rating, prediction_mae, behavior_diversity,
  personality_consistency, theater_violations, timestamp
) VALUES (...)
```

---

## Part 4: Drift Detection Baseline Establishment

Drift is the slow, silent degradation of system health. The CANON (page 333-339) specifies drift detection every 10 sessions. Proof must establish a baseline and define thresholds.

### Drift Baseline Establishment (Sessions 1-10)

**Metric 1: Cumulative Record Slope**
- Plot: Cumulative successful actions over time
- Baseline collection: Sessions 1-10
  ```sql
  SELECT
    DATE(created_at) as date,
    COUNT(CASE WHEN outcome_success = true THEN 1 END) as daily_successes,
    SUM(COUNT(CASE WHEN outcome_success = true THEN 1 END)) OVER (ORDER BY DATE(created_at)) as cumulative
  FROM outcomes
  WHERE session_id <= 10
  GROUP BY DATE(created_at)
  ```
- Compute: Linear regression slope
  ```
  slope = (count_sessions_10 - count_sessions_1) / 9
  ```
- Expected: Positive slope (system is getting more successful)
- **Baseline threshold:** slope > 0.5 (at least 4.5 cumulative new successes per session)

**Metric 2: Behavioral Diversity Trend**
- Plot: Unique action types per rolling 20-action window
- Baseline collection: Sessions 1-10
  ```sql
  SELECT
    session_id,
    ROW_NUMBER() OVER (ORDER BY created_at ASC) / 20 as window_num,
    COUNT(DISTINCT action_type) as unique_types
  FROM decisions
  WHERE session_id <= 10
  GROUP BY session_id, window_num
  ```
- Compute: Mean and std-dev of unique_types across all windows
  ```
  baseline_mean = AVG(unique_types)  -- Expected: ~5-6
  baseline_stdev = STDDEV(unique_types)  -- Expected: ~1-2
  ```
- **Baseline threshold:**
  - Healthy: baseline_mean ± 2*baseline_stdev
  - Red flag: decline below baseline_mean - 2*baseline_stdev (behavioral narrowing)

**Metric 3: Prediction Accuracy Trend**
- Plot: MAE per session
- Baseline collection: Sessions 1-10
  ```sql
  SELECT
    session_id,
    AVG(ABS(prediction_error)) as mae
  FROM outcomes
  WHERE session_id <= 10
  GROUP BY session_id
  ```
- Compute: Expected trajectory (should be decreasing)
  ```
  expected_mae_session_10 = initial_mae * (1 - 0.08)^9
  -- 8% improvement per session, roughly
  ```
- **Baseline threshold:**
  - Healthy: MAE at session 10 < initial_mae * 0.5 (50% improvement)
  - Red flag: MAE increasing after session 5 (environment changed or knowledge degraded)

**Metric 4: Guardian Interaction Quality**
- Plot: Guardian response rate to Sylphie-initiated comments
- Baseline collection: Sessions 1-10
  ```sql
  SELECT
    session_id,
    CAST(COUNT(CASE WHEN response_latency < 300 THEN 1 END) AS FLOAT) / COUNT(*) as quick_response_rate
  FROM communication_events
  WHERE initiator = 'Sylphie'
  AND session_id <= 10
  GROUP BY session_id
  ```
- Compute: Mean response rate
  ```
  baseline_response_rate = AVG(quick_response_rate)  -- Expected: ~0.4-0.6
  ```
- **Baseline threshold:**
  - Healthy: steady or increasing response rate
  - Red flag: declining response rate (Sylphie's comments becoming less engaging)

**Metric 5: Sustained Drive Patterns**
- Query: Any drive sustained > 0.7 for 10+ cycles without relief
- Baseline collection: Sessions 1-10
  ```sql
  SELECT
    drive_name,
    MAX(consecutive_cycles_above_threshold) as max_sustained_high
  FROM (
    SELECT
      drive_name,
      ROW_NUMBER() OVER (PARTITION BY drive_name ORDER BY tick_num) -
      ROW_NUMBER() OVER (PARTITION BY drive_name, drive_value > 0.7 ORDER BY tick_num) as group_num,
      COUNT(*) as consecutive_cycles_above_threshold
    FROM drive_ticks
    WHERE drive_value > 0.7
    AND session_id <= 10
    GROUP BY drive_name, group_num
  ) t
  GROUP BY drive_name
  ```
- **Baseline threshold:**
  - Healthy: No drive sustained > 0.7 for more than 3-4 cycles
  - Red flag: Any drive sustained > 0.7 for 10+ cycles (system cannot find relief)

### Drift Detection Protocol (Every 10 Sessions)

**Timing:** After session 20, 30, 40, 50, etc.

**Procedure:**
1. Compute all 5 drift metrics for the last 10 sessions (e.g., sessions 11-20)
2. Compare against baseline (sessions 1-10)
3. Flag anomalies

```sql
-- Drift detection query (example for session 11-20)
SELECT
  'cumulative_slope_decline' as anomaly_type,
  ABS(current_slope - baseline_slope) as deviation,
  current_slope < baseline_slope * 0.5 as is_anomaly
FROM (
  SELECT
    -- Baseline
    (SELECT
      (COUNT(*) FROM outcomes WHERE session_id <= 10 AND outcome_success = true) / 10.0
    ) as baseline_slope,
    -- Current period
    (SELECT
      (COUNT(*) FROM outcomes WHERE session_id BETWEEN 11 AND 20 AND outcome_success = true) / 10.0
    ) as current_slope
) t

UNION ALL

SELECT
  'behavior_diversity_decline',
  ABS(current_mean - baseline_mean),
  current_mean < baseline_mean - 2 * baseline_stdev
FROM (...)

-- Similar for other metrics
```

**Reporting:**
- Generate drift report: 5 metrics × comparison against baseline
- Green: Within healthy range
- Yellow: Trending toward red flag, monitor
- Red: Anomaly detected, requires investigation

**Investigation Trigger (Red Flag):**
When drift is detected, Proof should:
1. Query detailed session logs
2. Identify the inflection point (when did the system change?)
3. Investigate correlating code changes or environmental shifts
4. Report findings to Jim with recommendations

---

## Part 5: Attractor State Prevention and Early Detection

The CANON identifies 6 known pathological attractors. Proof must design early detection and prevention verification.

### Attractor 1: Type 2 Addict (HIGH RISK)

**CANON Definition:** "The LLM is always better, so Sylphie never develops Type 1 reflexes. The graph becomes write-only."

**Prevention Mechanisms:**
1. Type 2 carries explicit cost (latency, cognitive effort pressure)
2. Type 1 graduation mechanism (confidence > 0.80 AND MAE < 0.10 over 10 uses)
3. Confidence threshold dynamic (not fixed)

**Early Warning Metrics:**
```sql
SELECT
  session_id,
  CAST(COUNT(CASE WHEN arbitration_winner = 'Type1' THEN 1 END) AS FLOAT) / COUNT(*) as type1_ratio,
  AVG(CASE WHEN arbitration_winner = 'Type1' THEN 1 ELSE 0 END) as type1_avg_confidence
FROM decisions
WHERE session_id BETWEEN ? AND ?
GROUP BY session_id
```

**Healthy vs. Unhealthy:**
- **Healthy:** type1_ratio increasing over time, new Type 1 graduations each session
- **Red flag #1:** type1_ratio flat for 5+ sessions (no new graduates)
- **Red flag #2:** cognitive_effort_delta consistently negative (cost not affecting behavior)
- **Red flag #3:** Type 1 candidates have low confidence (threshold too high)

**Verification Test:**
1. Create an arbitrarily difficult Type 2 task (e.g., generate poetry)
2. System initially must use Type 2
3. Repeat 20 times
4. Expected: By repetition 15-20, system graduates to Type 1 OR properly signals incomprehension
5. Failure mode: System always uses Type 2, never graduates

### Attractor 2: Rule Drift (MEDIUM RISK)

**CANON Definition:** "Self-generated drive rules slowly diverge from design intent after many modifications."

**Prevention Mechanism:**
- Fixed evaluation core (Immutable Standard 6)
- Guardian-only rule approval
- Rule provenance tracking

**Early Warning Metrics:**
```sql
SELECT
  COUNT(DISTINCT id) as total_rules,
  COUNT(DISTINCT CASE WHEN approved_by_guardian = false THEN id END) as unapproved_rules,
  COUNT(DISTINCT CASE WHEN auto_modified = true THEN id END) as auto_modified_rules
FROM drive_rules
WHERE created_at > NOW() - INTERVAL '20 sessions'
```

**Healthy vs. Unhealthy:**
- **Healthy:** All new rules have approved_by_guardian = true; no auto modifications
- **Red flag #1:** unapproved_rules > 0 (system creating rules without approval)
- **Red flag #2:** auto_modified_rules > 0 (system modifying existing rules)
- **Red flag #3:** Cumulative rule drift metric > threshold
  ```sql
  -- Measure drift as KL divergence between rule effects over time
  SELECT KL_DIVERGENCE(rule_effects_session_1, rule_effects_session_20) as cumulative_drift
  ```

**Verification Test:**
1. Lock drive rules after session 1
2. Prevent system from proposing new rules for 10 sessions
3. Expected: System still develops (Type 1 graduation, personality emergence through behavior contingencies)
4. Verify: No performance degradation from locked rules

### Attractor 3: Hallucinated Knowledge (MEDIUM RISK)

**CANON Definition:** "LLM generates plausible but false entities/edges during Learning. Positive feedback amplifies them."

**Prevention Mechanisms:**
1. LLM_GENERATED provenance (lower base confidence: 0.35)
2. Confidence ceiling: no LLM_GENERATED > 0.60 without retrieval-and-use
3. Guardian confirmation required to exceed 0.60

**Early Warning Metrics:**
```sql
SELECT
  session_id,
  CAST(COUNT(CASE WHEN provenance = 'LLM_GENERATED' THEN 1 END) AS FLOAT) / COUNT(*) as llm_gen_ratio,
  COUNT(CASE WHEN provenance = 'LLM_GENERATED' AND confidence > 0.60 THEN 1 END) as ceiling_violations
FROM kg_nodes
WHERE created_at < session_end
GROUP BY session_id
```

**Healthy vs. Unhealthy:**
- **Healthy:** LLM_GENERATED ratio declining over time; ceiling_violations = 0
- **Red flag #1:** LLM_GENERATED ratio > 0.5 (graph is LLM-populated, not experience-grown)
- **Red flag #2:** ceiling_violations > 0 (confidence ceiling not enforced)
- **Red flag #3:** Nodes with high confidence and zero retrieval-and-use
  ```sql
  SELECT COUNT(*) as hallucination_risk
  FROM kg_nodes
  WHERE provenance = 'LLM_GENERATED'
  AND confidence > 0.50
  AND retrieval_and_use_count = 0
  ```

**Verification Test:**
1. Have LLM generate several false entities (e.g., "Sylphie is a robot")
2. Verify: Nodes created with LLM_GENERATED provenance
3. Verify: Confidence starts at 0.35
4. Repeat scenario without retrieval-and-use
5. Expected: Confidence remains at 0.35 (cannot exceed 0.60)
6. If LLM generates an edge connecting these false nodes
7. Expected: Edge also has LLM_GENERATED, starts at 0.35
8. Guardian correction: Guardian says "Sylphie is not a robot"
9. Expected: Confidence of false node reduced via Guardian correction weight (3x)

### Attractor 4: Depressive Attractor (MEDIUM RISK)

**CANON Definition:** "KG(Self) contains negative self-evaluations → low Satisfaction + high Anxiety → further failures reinforce negative self-model."

**Prevention Mechanisms:**
1. Self-evaluation on slower timescale than drive ticks (prevents lock-in)
2. Circuit breakers on ruminative loops

**Early Warning Metrics:**
```sql
SELECT
  session_id,
  AVG(CASE WHEN drive_name = 'Satisfaction' THEN drive_value END) as avg_satisfaction,
  AVG(CASE WHEN drive_name = 'Anxiety' THEN drive_value END) as avg_anxiety,
  -- Negative self-model strength
  (SELECT AVG(confidence) FROM kg_self WHERE valence < 0) as negative_self_strength
FROM drive_ticks
GROUP BY session_id
```

**Healthy vs. Unhealthy:**
- **Healthy:** Satisfaction >= 0.4, Anxiety <= 0.6
- **Red flag #1:** Satisfaction < 0.2 for 5+ sessions (sustained low reward)
- **Red flag #2:** Anxiety > 0.8 for 5+ sessions (sustained high stress)
- **Red flag #3:** Negative self-model strength increasing (kg_self nodes with negative valence accumulating)
- **Red flag #4:** Behavioral diversity declining + Satisfaction low (loss of interest)

**Verification Test:**
1. Deliberately introduce failures (prediction errors)
2. Record KG(Self) and drive state
3. Expected: Temporary low Satisfaction, elevated Anxiety
4. Over next 5 sessions, system should recover
5. Verify: Satisfaction returns to baseline; Anxiety decreases
6. Failure mode: If Satisfaction remains low and Anxiety high, depressive attractor may be engaged

### Attractor 5: Planning Runaway (LOW-MEDIUM RISK)

**CANON Definition:** "Many prediction failures → many Opportunities → many Plans → resource exhaustion."

**Prevention Mechanisms:**
1. Opportunity priority queue with decay
2. Rate limiting on Planning pipeline

**Early Warning Metrics:**
```sql
SELECT
  session_id,
  COUNT(DISTINCT id) as opportunity_count,
  COUNT(DISTINCT CASE WHEN status = 'planned' THEN id END) as planned_count,
  COUNT(DISTINCT CASE WHEN status = 'failed' THEN id END) as failed_plan_count,
  failed_plan_count / planned_count as failure_rate
FROM opportunities
WHERE created_at < session_end
GROUP BY session_id
```

**Healthy vs. Unhealthy:**
- **Healthy:** opportunity_count < 10 per session; planned_count < 5
- **Red flag #1:** opportunity_count > 20 per session (unbounded growth)
- **Red flag #2:** opportunity_count not decaying (old opportunities not retiring)
- **Red flag #3:** failure_rate > 0.5 (many Plans failing, creating more Opportunities)
- **Red flag #4:** Planning subsystem latency increasing (resource exhaustion)

**Verification Test:**
1. Inject high prediction error for 10 decisions
2. Expected: Many Opportunities created
3. Verify: Planning subsystem creates Plans up to rate limit
4. Verify: Failed Plans do NOT create infinite feedback loop
5. Verify: Opportunities age out of priority queue

### Attractor 6: Prediction Pessimist (LOW-MEDIUM RISK)

**CANON Definition:** "Early failures flood the system with low-quality procedures before the graph has substance."

**Prevention Mechanism:**
- Cold-start dampening: early prediction failures have reduced Opportunity generation weight

**Early Warning Metrics:**
```sql
SELECT
  session_id,
  AVG(ABS(prediction_error)) as avg_prediction_error,
  COUNT(DISTINCT id) as plan_count,
  (SELECT AVG(CASE WHEN success = true THEN 1 ELSE 0 END) FROM plan_outcomes
   WHERE plan_id IN (SELECT id FROM plans WHERE session_id = ?)) as plan_success_rate
FROM outcomes
GROUP BY session_id
```

**Healthy vs. Unhealthy:**
- **Healthy:** Early sessions have high prediction error (normal), but Plan success rate > 0.4
- **Red flag #1:** plan_success_rate < 0.3 (Plans failing frequently)
- **Red flag #2:** Plan count high in early sessions (early failures triggering too many Plans)
- **Red flag #3:** Plans created in session 1-3 still being used in later sessions (low-quality becoming permanent)

**Verification Test:**
1. Cold start: no WKG knowledge
2. First 10 decisions should have high error
3. Verify: Opportunities generated, but at reduced weight during cold-start
4. Verify: Plans created are low-confidence and quickly fail
5. Verify: These low-quality Plans are retired (confidence drops below retrieval threshold)

### Attractor State Dashboard

Create a health dashboard displaying all 6 attractor states:

```
ATTRACTOR STATE EARLY WARNING DASHBOARD
Session: 20

Type 2 Addict:          GREEN (Type1 ratio: 0.65, trending up)
Rule Drift:             GREEN (0 unapproved rules)
Hallucinated Knowledge: YELLOW (LLM_GENERATED ratio: 0.45, monitor)
Depressive Attractor:   GREEN (Satisfaction: 0.52, Anxiety: 0.38)
Planning Runaway:       GREEN (Opportunities: 7, Plans: 3)
Prediction Pessimist:   GREEN (Plan success rate: 0.62)

OVERALL: HEALTHY
```

---

## Part 6: Health Metrics Computation and Monitoring

The CANON (page 314-325) defines 7 primary health metrics. Proof must implement computation methods and establish monitoring.

### Metric 1: Type 1 / Type 2 Ratio

**Computation:**
```sql
SELECT
  session_id,
  CAST(COUNT(CASE WHEN arbitration_winner = 'Type1' THEN 1 END) AS FLOAT) / COUNT(*) as type1_ratio,
  CAST(COUNT(CASE WHEN arbitration_winner = 'Type2' THEN 1 END) AS FLOAT) / COUNT(*) as type2_ratio
FROM decisions
GROUP BY session_id
ORDER BY session_date ASC
```

**Healthy Range:** 0.0 to 1.0, should increase from ~0.1 to ~0.7 over 20 sessions
**Monitoring:** Plot Type1_ratio per session; flag if declining
**Dashboard Display:** Line chart, rolling 5-session average

### Metric 2: Prediction MAE

**Computation:**
```sql
SELECT
  session_id,
  AVG(ABS(prediction_error)) as mae,
  STDDEV(ABS(prediction_error)) as mae_stdev
FROM outcomes
GROUP BY session_id
ORDER BY session_date ASC
```

**Healthy Range:** Initial ~0.5, decreasing to ~0.2 by session 20, then stabilizing
**Monitoring:** Plot MAE per session; red flag if increasing after stabilization
**Dashboard Display:** Line chart with confidence band (MAE ± stdev)

### Metric 3: Experiential Provenance Ratio

**Computation:**
```sql
SELECT
  session_id,
  CAST(COUNT(CASE WHEN provenance IN ('SENSOR', 'GUARDIAN', 'INFERENCE') THEN 1 END) AS FLOAT) / COUNT(*) as exp_ratio,
  CAST(COUNT(CASE WHEN provenance = 'LLM_GENERATED' THEN 1 END) AS FLOAT) / COUNT(*) as llm_ratio
FROM kg_nodes
WHERE created_at < session_end
GROUP BY session_id
ORDER BY session_date ASC
```

**Healthy Range:** 0.3 to 1.0, should increase from ~0.4 to ~0.75 over 20 sessions
**Monitoring:** Plot exp_ratio per session; red flag if below 0.5
**Dashboard Display:** Stacked bar chart (experiential vs. LLM)

### Metric 4: Behavioral Diversity Index

**Computation:**
```sql
SELECT
  session_id,
  ROW_NUMBER() OVER (ORDER BY created_at ASC) / 20 as window_num,
  COUNT(DISTINCT action_type) as unique_actions
FROM decisions
WHERE session_id = ?
GROUP BY window_num
ORDER BY window_num ASC
```

**Then aggregate:**
```sql
SELECT
  session_id,
  AVG(unique_actions) as mean_diversity,
  STDDEV(unique_actions) as diversity_stdev
FROM (...previous query...) t
GROUP BY session_id
```

**Healthy Range:** 4-8 unique action types per rolling window, stable across sessions
**Monitoring:** Plot mean_diversity per session; flag if declining
**Dashboard Display:** Box plot showing distribution per session

### Metric 5: Guardian Response Rate

**Computation:**
```sql
SELECT
  session_id,
  COUNT(CASE WHEN communication_events.initiator = 'Sylphie' THEN 1 END) as sylphie_comments,
  COUNT(CASE WHEN communication_events.initiator = 'Sylphie'
    AND EXISTS (SELECT 1 FROM communication_events ce2
                WHERE ce2.comment_id = communication_events.id
                AND ce2.created_at - communication_events.created_at < INTERVAL '5 minutes')
    THEN 1 END) as responded_comments,
  CAST(responded_comments AS FLOAT) / sylphie_comments as response_rate
FROM communication_events
GROUP BY session_id
ORDER BY session_date ASC
```

**Healthy Range:** 0.3-0.7, stable or increasing
**Monitoring:** Plot response_rate per session; red flag if declining sharply
**Dashboard Display:** Line chart, rolling 3-session average

### Metric 6: Interoceptive Accuracy

**Computation:**
```sql
SELECT
  session_id,
  AVG(ABS(kg_self_reported_drive - actual_drive_value)) as interoceptive_error,
  STDDEV(ABS(kg_self_reported_drive - actual_drive_value)) as error_stdev
FROM (
  SELECT
    drive_ticks.session_id,
    drive_ticks.drive_name,
    drive_ticks.drive_value as actual_drive_value,
    -- KG(Self) models what Sylphie thinks about her own drive state
    kg_self.drive_value as kg_self_reported_drive
  FROM drive_ticks
  JOIN kg_self ON drive_ticks.drive_name = kg_self.drive_name
  WHERE drive_ticks.tick_time = kg_self.tick_time
) t
GROUP BY session_id
ORDER BY session_date ASC
```

**Healthy Range:** Error decreasing from ~0.3 to <0.15 over 20 sessions (improving self-awareness)
**Monitoring:** Plot interoceptive_error per session; red flag if increasing
**Dashboard Display:** Line chart showing error trajectory

### Metric 7: Mean Drive Resolution Time

**Computation:**
```sql
SELECT
  session_id,
  drive_name,
  AVG(cycles_to_relief) as mean_resolution_time
FROM (
  SELECT
    drive_ticks.session_id,
    drive_ticks.drive_name,
    drive_ticks.tick_num,
    (SELECT tick_num FROM drive_ticks dt2
     WHERE dt2.session_id = drive_ticks.session_id
     AND dt2.drive_name = drive_ticks.drive_name
     AND dt2.drive_value < 0.3
     AND dt2.tick_num > drive_ticks.tick_num
     LIMIT 1) - drive_ticks.tick_num as cycles_to_relief
  FROM drive_ticks
  WHERE drive_ticks.drive_value > 0.6  -- elevated
) t
WHERE cycles_to_relief IS NOT NULL
GROUP BY session_id, drive_name
ORDER BY session_date ASC
```

**Healthy Range:** 5-20 cycles for most drives, decreasing over time (improving efficiency)
**Monitoring:** Plot mean_resolution_time per drive per session; red flag if increasing
**Dashboard Display:** Multi-line chart (one line per drive)

### Health Dashboard Implementation

Create a React component that displays all 7 metrics:
```typescript
// frontend/src/components/HealthDashboard.tsx
export const HealthDashboard = () => {
  const [metrics, setMetrics] = useState<HealthMetrics>({
    type1_ratio: 0,
    prediction_mae: 0,
    exp_provenance_ratio: 0,
    behavioral_diversity: 0,
    guardian_response_rate: 0,
    interoceptive_accuracy: 0,
    drive_resolution_time: 0
  });

  useEffect(() => {
    // Fetch metrics from API every 30 seconds
    const interval = setInterval(async () => {
      const data = await fetch('/api/metrics/health').then(r => r.json());
      setMetrics(data);
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <Box>
      <Typography variant="h4">Development Health Metrics</Typography>
      <Grid container spacing={2}>
        <MetricCard title="Type 1 / Type 2 Ratio" value={metrics.type1_ratio} />
        <MetricCard title="Prediction MAE" value={metrics.prediction_mae} />
        {/* ... other metrics ... */}
      </Grid>
    </Box>
  );
};
```

---

## Part 7: Risks, Dependencies, and Ticket Breakdown

### Risks

**Risk 1: Verification Complexity Exceeds Test Coverage**
- **Description:** The verification strategy is comprehensive but complex. Implementing all aspects could require 40+ hours of engineering.
- **Mitigation:** Prioritize 3 "must verify" items (prediction loop, Type 1/Type 2, experiential provenance) before others. Use Proof's verification strategy as a prioritized roadmap, not a single implementation sprint.
- **Owner:** Proof, Jim

**Risk 2: Health Metrics Require Stable Database Schema**
- **Description:** Computing metrics requires stable field names and event types in TimescaleDB and Neo4j. If schema changes during implementation, all metric queries break.
- **Mitigation:** Finalize event schema in early implementation sprints. Once committed, treat event structure as immutable (with migration path for schema evolution).
- **Owner:** Database/Schema team

**Risk 3: Integration Test False Positives**
- **Description:** Full-loop integration tests are slow and flaky. A transient network error or timing issue could fail the entire test.
- **Mitigation:** Build integration tests to be resilient to transient failures (retry logic, time windows for event matching). Include verbose logging for post-failure diagnosis.
- **Owner:** QA/Testing

**Risk 4: Attractor State Detection May Fire Too Early or Too Late**
- **Description:** Early warning thresholds (e.g., "red flag if Type 1 ratio flat for 5 sessions") are heuristic. May produce false positives or miss real problems.
- **Mitigation:** Establish thresholds empirically during Phase 1. Monitor attractor metrics closely and adjust thresholds based on actual system behavior.
- **Owner:** Proof, Jim

**Risk 5: Lesion Tests Destroy System State**
- **Description:** Running a lesion test (e.g., disabling LLM) changes system behavior. Rolling back requires careful state restoration.
- **Mitigation:** Always run lesion tests on a copy of the system or in a dedicated test session. Never run lesion tests on the production system state. Snapshot databases before and after.
- **Owner:** Infrastructure

### Dependencies

**Dependency 1: Five Subsystems Must Be Minimally Functional**
- Decision Making, Communication, Learning, Drive Engine, Planning must all be implemented and communicating
- **Blocker:** Cannot run integration tests if any subsystem is missing
- **Owner:** Implementation teams

**Dependency 2: TimescaleDB Event Schema Must Be Finalized**
- Event types, field names, and structure must be stable
- **Blocker:** Metric queries depend on this; schema churn breaks verification
- **Owner:** Database team

**Dependency 3: Neo4j Provenance Tags Must Be Enforced**
- Every WKG node and edge must have provenance; must be impossible to create nodes without provenance
- **Blocker:** Lesion test and provenance verification depend on this
- **Owner:** Learning/Knowledge subsystem team

**Dependency 4: Drive Engine Must Be Isolated**
- Drive Engine must run in separate process with one-way communication
- **Blocker:** Cannot verify drive isolation without this architectural separation
- **Owner:** Drive Engine team

**Dependency 5: LLM Context Assembly Must Be Complete**
- LLM must receive complete context: episodic memory, drive state, WKG queries, person model
- **Blocker:** Theater Prohibition verification depends on accurate drive state injection
- **Owner:** Communication team

### Recommended Ticket Breakdown

**EPIC 10A: Prediction-Evaluation Loop Verification (Priority: P0)**
- Task 1: Implement prediction event recording (TimescaleDB schema, Decision Making instrumentation)
- Task 2: Implement outcome event matching (Decision Making → Learning → WKG update flow)
- Task 3: Verify confidence update via ACT-R formula (Learning subsystem verification)
- Task 4: Build prediction accuracy metric dashboard (GraphQL API + React component)
- **Acceptance Criteria:**
  - Prediction events recorded for every decision
  - Outcome events matched within 1 decision cycle
  - Confidence updates match ACT-R formula (tolerance: ±0.01)
  - Prediction MAE dashboard updates in real-time
- **Estimate:** 12 hours (implementation + testing)

**EPIC 10B: Type 1 / Type 2 Ratio Tracking (Priority: P0)**
- Task 1: Instrument decision arbitration (record Type1/Type2 winner, confidence, latency)
- Task 2: Implement Type 1 graduation criteria (confidence > 0.80 AND MAE < 0.10)
- Task 3: Verify cost dynamics (Type 2 latency and cognitive effort pressure)
- Task 4: Build Type 1/Type 2 ratio metric (per-session reporting)
- **Acceptance Criteria:**
  - Every decision records arbitration winner
  - Type 1 candidates tracked with confidence and recent MAE
  - Type 2 latency is 10-100x higher than Type 1
  - Type 1/Type 2 ratio plotted per session
- **Estimate:** 10 hours

**EPIC 10C: Provenance Integrity Verification (Priority: P0)**
- Task 1: Enforce provenance on all WKG nodes/edges (schema constraint, code enforcement)
- Task 2: Verify confidence ceiling for LLM_GENERATED (< 0.60 without retrieval-and-use)
- Task 3: Build provenance ratio metric (experiential vs. LLM_GENERATED)
- Task 4: Implement contradiction detection as learning signal
- **Acceptance Criteria:**
  - All WKG nodes/edges have provenance; zero violations
  - LLM_GENERATED nodes with confidence > 0.60 trigger alerts
  - Experiential provenance ratio dashboard
  - Contradictions flagged and preserved (not silently resolved)
- **Estimate:** 10 hours

**EPIC 10D: Drive Contingency Verification (Priority: P1)**
- Task 1: Verify satisfaction habituation curve (deltas: +0.20, +0.15, +0.10, +0.05, +0.02)
- Task 2: Verify anxiety amplification (1.5x reduction for high-anxiety failures)
- Task 3: Verify guilt repair contingency (acknowledgment + behavioral change)
- Task 4: Verify social comment quality (30-second response bonus)
- Task 5: Verify curiosity information gain (relief proportional to new knowledge)
- Task 6: Build behavioral diversity metric and drive relief efficiency metric
- **Acceptance Criteria:**
  - Each contingency fires as specified (within ±0.02 tolerance)
  - Behavioral diversity stable at 4-8 types per rolling window
  - Drive resolution time tracked per drive
- **Estimate:** 14 hours

**EPIC 10E: Planning Subsystem Verification (Priority: P1)**
- Task 1: Verify Opportunity detection (prediction error > 0.3 triggers Opportunity)
- Task 2: Verify Plan creation and validation by LLM Constraint Engine
- Task 3: Verify Plan execution in Decision Making (plans used in arbitration)
- Task 4: Verify Plan success rate > baseline (useful procedures)
- Task 5: Verify Planning Runaway prevention (opportunity decay, rate limiting)
- **Acceptance Criteria:**
  - Opportunities created for recurring prediction failures
  - Plans created, validated, and used
  - Plan success rate > baseline for useful procedures
  - Opportunity queue bounded (decay active)
- **Estimate:** 12 hours

**EPIC 10F: Full-Loop Integration Test (Priority: P1)**
- Task 1: Build integration test framework (cold start → 5 sessions → 10 sessions → 20 sessions)
- Task 2: Create guardian interaction scripts (5-10 turns per test session)
- Task 3: Implement per-session database queries (verify each subsystem)
- Task 4: Build integration test reporter (pass/fail, detailed diagnostics)
- **Acceptance Criteria:**
  - Integration test runs without human intervention
  - All five subsystems verified to be communicating
  - Data flows end-to-end (Decision → Learning → WKG → Drives)
  - Test report generated with pass/fail status and database snapshots
- **Estimate:** 16 hours

**EPIC 10G: Lesion Test Implementation (Priority: P1)**
- Task 1: Implement LLM lesion (disable Claude API, force Type 1)
- Task 2: Implement WKG lesion (empty graph returns, force LLM-only)
- Task 3: Implement Drive Engine lesion (neutral drives, test personality dependence)
- Task 4: Build lesion test runner (3 lesions × 3 time points = 9 test runs)
- Task 5: Build lesion comparison matrix and deficit analysis
- **Acceptance Criteria:**
  - Each lesion is runnable in isolation
  - Lesion tests produce deficit profiles (interaction success %, response quality, MAE, diversity, personality)
  - Comparison matrix tracks system health across three lesion types
  - Lesion results saved to TimescaleDB for trend analysis
- **Estimate:** 14 hours

**EPIC 10H: Drift Detection Baseline (Priority: P2)**
- Task 1: Establish baseline metrics (sessions 1-10)
  - Cumulative record slope, behavioral diversity trend, prediction accuracy trend, guardian response rate, sustained drive patterns
- Task 2: Implement drift detection query (compare current 10-session period against baseline)
- Task 3: Build drift detection reporter (green/yellow/red flagging)
- Task 4: Implement drift investigation triggers
- **Acceptance Criteria:**
  - Baseline metrics computed and stored after session 10
  - Drift detection runs every 10 sessions (after session 20, 30, 40, ...)
  - Anomalies flagged with investigation guide
- **Estimate:** 10 hours

**EPIC 10I: Attractor State Early Detection (Priority: P2)**
- Task 1: Implement Type 2 Addict early warnings (Type 1 ratio flat, no new graduates, cost not affecting behavior)
- Task 2: Implement Rule Drift early warnings (unapproved rules, auto-modified rules, cumulative drift metric)
- Task 3: Implement Hallucinated Knowledge early warnings (LLM_GENERATED ratio, ceiling violations, retrieval-free high-confidence nodes)
- Task 4: Implement Depressive Attractor early warnings (low Satisfaction, high Anxiety, negative self-model accumulation)
- Task 5: Implement Planning Runaway early warnings (unbounded opportunity growth, high Plan failure rate)
- Task 6: Implement Prediction Pessimist early warnings (high Plan failure rate in early sessions)
- Task 7: Build attractor state dashboard (6 attractors × red/yellow/green status)
- **Acceptance Criteria:**
  - All 6 attractors monitored continuously
  - Early warning metrics computed per session
  - Dashboard displays green/yellow/red status
  - Red flags trigger investigation protocol
- **Estimate:** 18 hours

**EPIC 10J: Health Metrics Dashboard (Priority: P2)**
- Task 1: Implement 7 health metric queries (Type 1/Type 2, MAE, provenance ratio, diversity, guardian response, interoceptive accuracy, drive resolution time)
- Task 2: Build metric computation API endpoints
- Task 3: Build React dashboard with 7 metric cards
- Task 4: Implement metric history graphs (per-session trends)
- Task 5: Add metric alerting (red flags for declining metrics)
- **Acceptance Criteria:**
  - All 7 metrics display in real-time on dashboard
  - Metrics update every 30 seconds
  - Historical trends plotted per session
  - Declining metrics trigger alerts
- **Estimate:** 12 hours

**Total Epic 10 Estimate: 118 hours (~3 weeks full-time, 2 developers)**

**Recommended Scheduling:**
- Week 1: EPIC 10A, 10B, 10C (prediction loop, Type 1/Type 2, provenance)
- Week 2: EPIC 10D, 10E (drive contingencies, planning)
- Week 3: EPIC 10F, 10G, 10H (integration test, lesion test, drift baseline)
- Week 4: EPIC 10I, 10J (attractor states, health dashboard)

---

## Part 8: Conclusion

Epic 10 is the verification sprint that transforms Sylphie from theoretical architecture to empirical proof. Proof's role is to ensure that:

1. **The 6 "must prove" items are actually verifiable** — each has a specific verification strategy, measurable metrics, and concrete test procedures
2. **The system integrates correctly** — all five subsystems communicate, data flows end-to-end, and no subsystem works in isolation
3. **Health metrics are computed and monitored** — the CANON's 7 primary metrics are tracked continuously, dashboarded, and trending correctly
4. **Known attractor states are detected early** — all 6 pathological patterns have early warning metrics that trigger investigation
5. **Development is genuinely occurring** — the lesion test shows that Type 1 is developing, the WKG is growing with experiential knowledge, personality is emerging from contingencies, and the system is not just an LLM wrapper

This analysis provides the roadmap. Implementation details will emerge as the system is built, but the verification framework ensures that every claim in the CANON can be tested, measured, and validated.

---

**Analysis Prepared By:** Proof, Quality Assurance Engineer
**Date:** 2026-03-29
**Status:** COMPLETE - Ready for Implementation Planning
