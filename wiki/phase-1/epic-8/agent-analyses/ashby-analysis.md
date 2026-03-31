# ASHBY SYSTEMS ANALYSIS: Epic 8 (Planning Subsystem)

**Author:** ASHBY, Systems & Cybernetics Theorist
**Date:** 2026-03-29
**Scope:** Whole-system dynamics of the Planning subsystem in Sylphie Phase 1
**Theoretical Framework:** Cybernetics, complex adaptive systems theory, dynamical systems analysis

---

## Executive Summary

The Planning subsystem is a **variety amplifier** that increases Sylphie's behavioral repertoire by generating new procedures from detected opportunities. From a cybernetic perspective, Planning is essential for requisite variety maintenance -- without it, the system's response repertoire is fixed by Learning alone and cannot adapt to novel problem patterns.

However, Planning introduces two significant feedback dynamics that require careful regulation:

1. **Positive feedback loop (opportunity → plan → execution → prediction failure → new opportunity)** that amplifies response variety but risks runaway resource consumption
2. **Negative feedback loops** (opportunity decay, rate limiting, cold-start dampening) that stabilize the system but risk insufficient adaptation

**Critical finding:** The designed rate-limiting and decay mechanisms are **structurally sound** and grounded in cybernetic principles of ultrastability and requisite variety. The linear cold-start dampening curve is adequate but suboptimal; a sigmoid would better match system development dynamics. The priority queue with exponential decay is stable under normal load but shows potential oscillation at boundary conditions (queue filling rapidly from burst failures).

**Highest risk:** The feedback loop coupling between Planning and Learning. As Learning improves the graph, Planning's simulations become more accurate, which increases plan success rates, which reduces prediction failures, which reduces Opportunity generation. The system converges toward a stable state where Planning becomes inactive. This is desirable if it signals maturity, but dangerous if the environment changes (new conversational contexts, new prediction failure modes) and the system is caught with an inactive Planning subsystem.

**Recommendation:** Maintain the current design. Add system-level monitoring for Planning activation dynamics and integrate with the Drift Detection framework (CANON) to detect when environmental novelty outpaces Planning's capacity.

---

## 1. Planning as a Variety Amplifier: Law of Requisite Variety Analysis

### 1.1 The Variety Problem

Ashby's Law of Requisite Variety states: **Only variety can absorb variety.** A regulator that must handle *D* distinguishable environmental situations must have at least *R* distinguishable responses, where |R| >= |D|, or regulation fails.

In Sylphie's context:

- **Environmental variety (D):** Conversational contexts, prediction failure modes, novel combinations of guardian feedback, unexpected outcomes from known actions
- **Behavioral variety (R):** Actions, responses, decision patterns available to the system

Without the Planning subsystem, the system's behavioral variety is fixed: the union of Type 1 reflexes (learned from experience, limited to successful past patterns) and Type 2 responses (LLM-generated, but expensive and require explicit invocation through the arbitration mechanism).

### 1.2 Planning as a Variety Generator

The Planning subsystem increases variety through **procedure generation:**

1. **Input:** Recurring prediction failures (evidence that current variety is insufficient)
2. **Process:** Research patterns, simulate outcomes, propose plans, validate constraints, create procedures
3. **Output:** New procedure nodes in the WKG with triggering contexts and action sequences
4. **Integration:** Procedures become available to Decision Making as Type 1/Type 2 candidates

This is a **closed-loop variety amplification mechanism:**

```
Prediction Failure → Opportunity → Research → Simulate → Propose → Validate → Procedure
                                                                                    ↓
                                                          Decision Making tries procedure
                                                                    ↓
                                            New prediction (success or failure)
                                                          ↓
                                  Outcome feeds back to confidence and drives
```

### 1.3 Growth Rate vs. Environmental Novelty

The system's health depends on whether variety generation outpaces, matches, or falls behind environmental novelty:

| Condition | System Behavior | Risk |
|-----------|-----------------|------|
| **Variety growth >> novelty rate** | Overshoots. Creates more procedures than needed. Resource waste. | Planning Runaway (recognized attractor state) |
| **Variety growth ~ novelty rate** | Matches environment. Healthy adaptation. | None, assuming quality |
| **Variety growth << novelty rate** | Undershoots. System cannot handle new situations. Defaults to Type 2. | Requisite variety failure -- perpetual LLM dependency |

The designed rate-limiting parameters (3 plans/hour, max 10 active) create a **bounded generation rate:**

Maximum theoretical variety growth = 3 new procedures per hour × 24 hours = 72 new behaviors per day.

This is conservative and appropriate for a cold-start system. However, the rate is **fixed**, not adaptive. If environmental novelty increases (guardian introduces new conversational domains, new types of failure modes), the fixed rate becomes inadequate.

### 1.4 Requisite Variety Verdict

**The Planning subsystem is adequate for Phase 1 requisite variety maintenance if:**

1. Environmental novelty remains moderate (conversational variation within a domain, prediction failures that cluster into recognizable patterns)
2. Cold-start dampening successfully delays Planning activation until the graph has basic competence (prevents garbage procedures in early operation)
3. Plan execution feedback reaches Decision Making and influences confidence dynamics (plans that fail produce prediction errors that feed back to Planning as new Opportunities)

**The system risks insufficient variety if:**

1. The environment introduces qualitatively new categories of situations (e.g., multi-party conversation after training on single-guardian interaction)
2. Cold-start dampening is too aggressive, delaying Planning beyond the point when basic procedures would be valuable
3. Plan execution feedback breaks (Planning creates procedures but they are never tried, or outcomes are not recorded back to the Planning subsystem)

---

## 2. Feedback Loop Mapping: Complete Topology

### 2.1 The Core Planning Feedback Loop

**Loop 1: Prediction-Failure-to-Procedure Cycle**

```
1. Decision Making makes prediction P
2. Action executed, outcome O observed
3. |P - O| = error
4. If error > threshold (MAE > 0.15):
   4a. Drive Engine creates Opportunity
   4b. Planning receives Opportunity
   4c. Planning creates Procedure
   4d. Procedure available to Decision Making as action candidate
5. Next similar situation: Decision Making tries Procedure
6. Outcome provides new prediction data
7. Loop closes back to step 1
```

**Classification:** POSITIVE feedback loop (amplifying)
**Characteristic:** Each failure that triggers a plan creates a new behavioral option, which generates more prediction data, which potentially creates more Opportunities, which generate more plans.

**Time constant:** ~minutes to hours (dependent on opportunity frequency)
**Gain:** Bounded by rate limiting (maximum 3 plans/hour)

### 2.2 The Opportunity Decay Loop

**Loop 2: Opportunity Priority Decay**

```
1. Opportunity created with priority P
2. Opportunity enqueued
3. Time passes: t = 0 to t = T
4. Priority decays: P(t) = P₀ * (1 - decay_rate)^t
5. If not processed by time T:
   5a. Priority approaches 0
   5b. Opportunity deprioritized relative to newer opportunities
   5c. Eventually opportunity drops below processing threshold
   5d. Opportunity removed from queue
6. Loop closes (opportunity exits the system)
```

**Classification:** NEGATIVE feedback loop (stabilizing)
**Characteristic:** Prevents indefinite accumulation of unaddressed Opportunities.

**Time constant:** Hours (decay_rate = 0.10/hour means 50% decay in ~7 hours)
**Effect:** Old, unresolved Opportunities lose influence over time.

### 2.3 The Rate-Limiting Loop

**Loop 3: Planning Resource Constraint**

```
1. Planning subsystem attempts to process Opportunity
2. Check rate limiter:
   2a. Plans created this hour >= 3? → BLOCKED
   2b. Active plans >= 10? → BLOCKED
   2c. Token budget exhausted? → BLOCKED
3. If blocked:
   3a. Event logged
   3b. Opportunity remains in queue
   3c. No plan created
4. Loop effect: Caps resource consumption regardless of Opportunity volume
```

**Classification:** NEGATIVE feedback loop (stabilizing)
**Characteristic:** Prevents resource exhaustion regardless of environmental demand.

**Time constant:** Hours (window resets hourly)
**Effect:** Hard ceiling on planning throughput.

### 2.4 The Cold-Start Dampening Loop

**Loop 4: Development-Gated Opportunity Weighting**

```
1. Prediction failure occurs
2. Drive Engine evaluates for Opportunity creation
3. Check decision count:
   3a. If decision_count < 100:
       - dampening = 0.8 * (1 - decision_count / 100)
       - Opportunity weight *= (1 - dampening)
   3b. If decision_count >= 100:
       - dampening = 0
       - Opportunity weight unchanged
4. Dampened Opportunities are lower priority
5. Loop effect: Early failures have reduced impact on Planning
```

**Classification:** NEGATIVE feedback loop (stabilizing)
**Characteristic:** Delays Planning activation until the system has minimal competence.

**Time constant:** Depends on decision rate (if 1 decision/second, cold-start phase lasts ~1.67 minutes)
**Effect:** Reduces Prediction Pessimist attractor risk.

### 2.5 Interaction of Loops: Feedback Topology

The system contains at least four distinct feedback loops operating simultaneously:

```
                           ┌─── Prediction Failure ───┐
                           │                          │
                           ↓                          │
                    ┌─ OPPORTUNITY ─┐               │
                    │                │               │
    Loop 1 (POSITIVE)│                │Loop 2 (NEGATIVE)
    Plan creation   │  Priority: P(t)│  Decay
                    │                │
                    └──────┬─────────┘
                           │
                    ┌──────↓──────┐
                    │   PLANNING  │
                    │  PIPELINE   │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
         Loop 3       Loop 3      Loop 3
      (NEGATIVE)   (NEGATIVE)  (NEGATIVE)
      Rate limit   Active cnt   Token bgt
              │            │            │
              └────────────┼────────────┘
                           │
                    ┌──────↓──────┐
                    │  PROCEDURE  │
                    │   CREATED   │
                    └──────┬──────┘
                           │
                    Decision Making
                    tries procedure
                           │
                    ┌──────↓──────┐
                    │   OUTCOME   │
                    │  EVALUATED  │
                    └──────┬──────┘
                           │
                    Loop closes back to
                    Prediction Failure
```

### 2.6 Loop Analysis: Balance and Stability

**Positive Feedback (Loop 1):**
- **Mechanism:** Prediction failure → Opportunity → Plan → Procedure → New behavioral option
- **Risk:** Runaway if unchecked. More plans → more options → more predictions → more failures → more plans
- **Limiting mechanism:** Bounded by Loop 3 (rate limiting) and Loop 2 (decay)

**Net Negative Feedback (Loops 2, 3, 4):**
- **Mechanism:** Opportunities fade over time (Loop 2), planning throughput is capped (Loop 3), and early-stage failures are dampened (Loop 4)
- **Effect:** System does not accumulate infinite opportunities or create infinite plans
- **Risk:** If too aggressive, system adaptation is too slow; environment changes faster than system can respond

**Critical Coupling:** Loop 1 and Loop 3 interact directly. The rate limiter prevents Loop 1 from running away, but it also caps beneficial adaptation. The designed limit (3 plans/hour) must be calibrated such that:
- Under normal operation (steady-state prediction failures), the limit is never reached
- During adaptation (burst of novel failures), the limit becomes the bottleneck, preventing runaway while still allowing measured response

### 2.7 Feedback Loop Verdict

**Healthy condition:** Loop 1 (plan creation) operates at <3 per hour under normal conditions. Loop 2 (decay) keeps queue size below maximum. Loop 3 (rate limit) is not actively blocking. Loop 4 (dampening) transitions to 0 by decision 100.

**Warning signs:**
- Loop 3 triggers rate limiting more than once per day (indicates environmental novelty exceeding planning capacity)
- Loop 2 queue size approaching maximum (indicates more Opportunities than Planning can process)
- Loop 4 still dampening at decision 200+ (indicates cold-start threshold was set too high)

---

## 3. Attractor State Analysis: Planning Runaway & Prediction Pessimist

### 3.1 Planning Runaway Attractor State

**Pathological behavior:** The Planning subsystem creates plans faster than the system can evaluate them. Plans consume resources (LLM tokens, WKG updates, storage). Resource exhaustion degrades overall system performance. Performance degradation causes more prediction failures. More failures create more Opportunities. The system spirals toward a state where Planning is constantly active and increasingly ineffective.

**Mathematical characterization:**

Let:
- `O(t)` = number of unprocessed Opportunities at time t
- `P(t)` = number of active plans at time t
- `F(t)` = prediction failure rate (failures per hour)
- `λ` = planning rate (plans created per opportunity)

Runaway dynamics:

```
dO/dt = F(t) - λ * P(t)  (opportunity intake minus processing)
dP/dt = λ * O(t) - μ * P(t)  (plan creation minus completion/demotion)
```

Without limiting: If F(t) increases, O(t) increases, which increases dP/dt, which increases plan creation, which may degrade performance, which increases F(t). Positive feedback cycle.

**Basin of Attraction:**

The Planning Runaway attractor exists in a specific region of state space:

- High prediction failure rate (F > 5 per hour)
- High opportunity queue depth (O > 30)
- Plan creation rate at rate-limit ceiling (3 plans/hour, continuously)
- System performance degraded (Type 1/Type 2 ratio declining, prediction MAE increasing)

**Entry points:**

1. **Environment shift:** Guardian introduces new conversational domain. Prediction failures spike. Opportunity queue fills rapidly.
2. **Plan quality degradation:** Earlier plans start failing. Their failures create new Opportunities. System creates more plans to address original failures plus new failures from bad plans.
3. **Rate limit inaction:** Rate limiter becomes active (capping at 3 plans/hour) but Opportunities continue accumulating faster than they decay.

**Basin boundaries:**

The system escapes Planning Runaway if any of these occur:

- Prediction failure rate drops (system learns or environment stabilizes) → fewer Opportunities
- Plan quality improves (simulations become more accurate) → fewer plan failures
- Rate limiter prevents further plan creation while decay reduces queue → queue drains
- Opportunity decay accelerates (shorter half-life) → old Opportunities disappear faster

### 3.2 Prevention Mechanisms for Planning Runaway

The CANON and Epic 8 design specify three stabilization mechanisms:

**Mechanism 1: Opportunity Priority Decay (Loop 2)**

```
Priority(t) = Priority₀ * (1 - 0.10)^(hours_in_queue)
```

Half-life = 6.6 hours. An Opportunity loses half its priority in less than 7 hours.

**Cybernetic role:** Negative feedback loop. Older Opportunities lose influence, preventing indefinite accumulation.

**Stability analysis:**

In steady state, where Opportunities are created at rate `F` and decay at rate `γ`:

```
dO/dt = F - γ*O = 0 (equilibrium)
O* = F / γ
```

With decay rate 0.10/hour and 24-hour queue window:

```
Average Opportunities in queue = F / (0.10 * 24 / ln(2)) ≈ F / 1.73
```

If F = 5 failures/hour, queue equilibrium ≈ 2.9 Opportunities. This is well below the queue maximum (50).

**Vulnerability:** The decay rate (0.10/hour) is fixed. If environmental novelty increases substantially (F >> 5), the equilibrium queue depth increases proportionally. The queue may fill despite decay.

Example: If F = 30 failures/hour (e.g., sudden introduction of 5 new conversational domains), equilibrium queue ≈ 17. Still below maximum, but growing. If F continues to increase, the queue fills within hours.

**Verdict on Decay:** Adequate for expected Phase 1 operation. **Recommend monitoring queue fill rate.** If queue approaches 30+ regularly, the decay rate should increase (reduce half-life) or the environmental assessment should trigger a system-level adaptation event.

**Mechanism 2: Hard Rate Limiting (Loop 3)**

```
if plans_created_this_hour >= 3: BLOCK
if active_plans >= 10: BLOCK
if tokens_used_this_hour >= token_budget: BLOCK
```

**Cybernetic role:** Hard ceiling on planning throughput. Prevents resource exhaustion.

**Stability analysis:**

The rate limiter is a **threshold switch**, not a smooth regulator. It either allows planning (plans created up to 3/hour) or blocks it (plans ≥ 3/hour). This creates potential for **limit cycle behavior:**

```
Hour 0-1: Plans created = 0. Limit not active.
Hour 1-2: Plans created = 3. Limit activated. No new plans accepted.
Hour 2-3: Limit window resets. Plans created = 0. Limit inactive.
Hour 3-4: Plans created = 3. Limit activated again.
```

If the Opportunity arrival rate is constant and high (>3/hour), the rate limiter toggles ON/OFF hourly. This creates a **sawtooth pattern** of planning activity.

**Is this stable?**

Yes, the rate limiter prevents unbounded growth. The system cycles between "planning active" and "planning blocked" at a predictable frequency. This is stable but potentially inefficient -- Opportunities queue up during "planning blocked" periods.

**Optimization opportunity:** Instead of a hard 3-plan/hour ceiling, consider a **sliding window** or **queue-depth-responsive** rate. But the current design is safe.

**Verdict on Rate Limiting:** Effective. The 3-plan/hour and 10-active-plans limits are conservative. For Phase 1, where the system is small and resource-constrained, these limits are appropriate. **Recommend monitoring active plan count and queue depth in tandem.** If active plans are consistently near 10 while queue depth is high, the rate limit may be too aggressive.

**Mechanism 3: Cold-Start Dampening (Loop 4)**

```
dampening(decision_count) = 0.8 * (1 - decision_count / 100)
Opportunity_weight *= (1 - dampening)
```

Linear ramp from 80% dampening at decision 0 to 0% dampening at decision 100.

**Cybernetic role:** Gating mechanism. Delays Planning activation until the system has built basic graph competence.

**Stability analysis:**

The linear ramp assumes that graph competence grows linearly with decision count. Is this realistic?

**ACT-R confidence dynamics:**

```
confidence(t) = base + 0.12 * ln(count) - d * ln(hours + 1)
```

Confidence grows logarithmically with retrieval count. A node retrieved 10 times has higher confidence than one retrieved 1 time, but not 10x higher. This is sublinear growth.

Meanwhile, dampening decays linearly: `0.8 - 0.8 * (decisions/100)`.

**Mismatch:** At decision 50, dampening is 0.4 (40% of Opportunities are suppressed). By ACT-R, the graph's average confidence has grown from base values (0.35-0.60) to... roughly 0.40-0.65 (logarithmic improvement). Many nodes are still below the retrieval threshold (0.50).

**Implication:** Linear dampening ramps **too quickly**. By decision 100, dampening is completely gone, but the graph may not have sufficient competence to support good Planning yet.

**Better approach:** **Sigmoid ramp** instead of linear.

```
dampening(decision_count) = 0.8 * exp(-2 * (decision_count / 100)^2)
```

This keeps dampening high (>0.7) through the first 30% of cold-start, then transitions smoothly to 0 by decision 100. Sigmoid curves are characteristic of development and learning (Piaget's stages, population growth, adoption curves) and better match the actual confidence growth rate.

**Verdict on Cold-Start Dampening:**

The linear ramp is **functional but suboptimal**. The system will not suffer catastrophic failure with linear dampening (the rate limiter still caps planning at 3/hour), but a sigmoid ramp would better match the system's actual development trajectory. **Recommend considering a sigmoid variant for later iterations.**

### 3.3 Prediction Pessimist Attractor State

**Pathological behavior:** Early in operation, the graph is sparse and predictions are unreliable. Prediction failures are frequent because the system lacks knowledge, not because it lacks plans. If these early failures trigger Opportunity creation and plan generation, the system fills its procedure store with low-quality plans based on insufficient evidence. These bad plans accumulate at low confidence (0.35), potentially interfering with later learning when better plans should be available.

**Mathematical characterization:**

Let:
- `K(t)` = graph knowledge quality (e.g., average node confidence)
- `P(t)` = number of procedures in WKG
- `F(t)` = prediction failure rate
- `α` = evidence threshold for planning (minimum failures to create opportunity)

Early dynamics (cold-start):
- K is low because graph is sparse
- F is high because confidence is low (many predictions fail due to missing knowledge)
- Each failure generates an Opportunity (even with dampening)
- Opportunities generate Plans (attempts to solve failure patterns)
- Plans are based on sparse evidence (few similar events observed)
- Plans are weak because evidence is weak
- Plans get created anyway (constraint engine passes them because they're not unsafe, just untested)
- Later, when K improves, the system is cluttered with weak procedures from the cold-start phase

**Basin of Attraction:**

Prediction Pessimist is a **transient attractor** -- it only exists during cold-start. The system enters it if:

1. Cold-start dampening is insufficient (lets too many Opportunities through)
2. Evidence threshold for Opportunity creation is too low (creates Opportunities from single failures)
3. Plan quality validation is weak (constraint engine passes implausible plans)

**Escape path:** Time and development. As the graph accumulates knowledge, K increases. Prediction failure rate F decreases naturally (more knowledge → better predictions). Fewer new failures mean fewer new Opportunities. The Prediction Pessimist attractor is abandoned as the system grows.

### 3.4 Prevention Mechanisms for Prediction Pessimist

**Prevention 1: Cold-Start Dampening**

The designed 80% dampening at decision 0 means that early prediction failures are 80% less likely to create Opportunities. This is conservative and appropriate.

With 80% dampening, an early failure needs to recur at least 3 times before it's likely to create an Opportunity (due to priority weighting). This ensures only robust failure patterns trigger planning in early operation.

**Prevention 2: Evidence Threshold**

The Planner's agent profile specifies evidence sufficiency check:

```
hasSufficientEvidence = failures.length >= 2 &&
  discrepancies.some(d => d.mae > 0.15);
```

This requires at least 2 failures AND a significant discrepancy before Planning proceeds. Single failures do not generate plans.

**Prevention 3: Constraint Validation**

Even if an Opportunity passes to Planning, the constraint engine validates proposals. Plans that are incoherent or violate Immutable Standards are rejected. This prevents obviously bad procedures from entering the WKG.

**Verdict on Prediction Pessimist Prevention:**

The combination of cold-start dampening + evidence threshold + constraint validation is robust. The system will not catastrophically fill with bad procedures. There is still a risk that weak procedures accumulate, but they will be:
1. Low confidence (0.35 LLM_GENERATED base)
2. Below retrieval threshold (0.50) and thus not selected by Decision Making
3. Subject to decay if not used
4. Demoted if their outcomes are poor

This is acceptable for Phase 1. **Recommend monitoring:** How many procedures are in the WKG by session 10? How many are above the retrieval threshold? If the number of untested procedures (confidence < 0.50) exceeds 20% of the total, the system may be accumulating weak procedures. Increase cold-start dampening or evidence threshold in response.

---

## 4. Rate Limiting as a Regulator: Sufficiency and Boundary Behavior

### 4.1 The Rate Limiter as a Variety Control Mechanism

The rate limiter caps three resources:

1. **Plan creation rate:** 3 plans per hour
2. **Active plans:** 10 concurrent procedures in consideration/execution
3. **Token budget:** Finite budget per plan proposal

From a cybernetic perspective, this is a **resource-based regulator** -- it limits the system's capacity to explore solution space based on available resources, not based on environmental demand.

### 4.2 Sufficiency Analysis

**Is 3 plans/hour sufficient?**

This depends on:
- Prediction failure rate (opportunities per hour)
- Evidence threshold (how many failures trigger one opportunity)
- Planning success rate (what fraction of processed opportunities yield viable plans)

**Scenario 1: Normal Operation**
- Prediction failure rate: 2/hour (occasional mispredictions as graph stabilizes)
- Evidence threshold: minimum 2 failures to create 1 Opportunity
- Planning success rate: 50% (half of researched opportunities yield viable plans)

Expected plan creation rate: 2 failures/hour → 1 opportunity/hour → 0.5 plans/hour.

Rate limiter is **inactive**. Planning operates below capacity.

**Scenario 2: High Novelty**
- Prediction failure rate: 8/hour (new domain, many novel situations)
- Evidence threshold: 2 failures per opportunity
- Planning success rate: 40% (sparse evidence makes planning harder)

Expected plan creation rate: 8 failures/hour → 4 opportunities/hour → 1.6 plans/hour.

Rate limiter is **inactive**. Planning still operates below capacity.

**Scenario 3: Burst Novelty**
- Prediction failure rate: 15/hour (rapid environmental change)
- Evidence threshold: 2 failures per opportunity
- Planning success rate: 30% (very sparse evidence)

Expected plan creation rate: 15 failures/hour → 7.5 opportunities/hour → 2.25 plans/hour.

Rate limiter is **approaching capacity**. Planning would hit the ceiling within hours if the burst sustains.

**Scenario 4: Sustained High Novelty**
- Prediction failure rate: 20/hour (extreme environmental shift)
- Evidence threshold: 1 failure per opportunity (system is desperate)
- Planning success rate: 25%

Expected plan creation rate: 20 failures/hour → 20 opportunities/hour → 5 plans/hour.

Rate limiter is **capping the system**. Only 3 of 5 expected plans are created per hour. 2 opportunities per hour are never processed.

**Verdict:** The 3-plan/hour rate is **adequate for normal and high-novelty operation** but may be insufficient if the environment changes extremely rapidly or the system encounters multiple novel domains simultaneously.

### 4.3 Active Plan Limit (10 concurrent)

The second dimension of rate limiting is concurrent active plans. A plan is "active" if it has been created and Decision Making is considering using it.

**Questions:**
1. How much does each active plan consume in resources (WKG nodes/edges, memory)?
2. What is the overhead of maintaining 10 active procedures?
3. Is 10 the right number?

**From Planner's profile:** The limit appears to be a resource ceiling without detailed justification. Assuming each procedure node is small (name, trigger context, action sequence, expected outcome) and each uses minimal memory, 10 active procedures is conservative.

**Risk:** The "active" definition is unclear. Is a procedure active only while Decision Making is executing it? Or is it active from creation until it graduates to Type 1 or decays below retrieval threshold? If the latter, procedures can accumulate faster than they graduate, and the limit of 10 may throttle the system unnecessarily.

**Recommendation:** Clarify the definition of "active plan" during E8 implementation. If it means "procedures in active use by Decision Making in the last N hours," then 10 is reasonable. If it means "all procedures since creation that have not yet graduated to Type 1," then it may be too restrictive.

### 4.4 Boundary Behavior: What Happens When Limits Are Hit

**Boundary 1: Plan Creation Rate Limit (3/hour)**

When the rate limiter blocks a plan:

```
Planning attempts to create a 4th plan
Rate limiter says: "You've already created 3 this hour, blocked"
Event logged: PLANNING_RATE_LIMITED
Opportunity remains in queue, decays per Loop 2
System continues operating, Planning pauses until window resets
```

**Stability at boundary:** System remains stable. Opportunities are not lost (they're in the queue), just delayed. If the burst passes, the queue drains normally. If the burst persists, Opportunities will accumulate and some will decay away unaddressed. This is acceptable -- it signals that the environment is changing faster than the system can adapt.

**Behavior:** The system exhibits **graceful degradation**. It does not crash or deadlock; it simply stops planning until resources free up.

**Boundary 2: Active Plan Limit (10 concurrent)**

When the system tries to create an 11th active plan:

```
Planning attempts to create the 11th procedure
Rate limiter says: "You have 10 active plans, blocked"
Event logged: PLANNING_ACTIVE_PLAN_LIMIT
Opportunity stays in queue
Existing procedures must complete, be promoted to Type 1, or demote below threshold
Only then can new procedures be created
```

**Stability at boundary:** This is a **bottleneck**, not a hard limit. If procedures are demoting or graduating faster than new ones are needed, the system remains below the limit. If new procedures are created faster than old ones clear, the system hits the limit and Planning pauses.

**Behavior:** Again, graceful degradation. The system does not break; it just pauses procedure creation.

**Boundary 3: Token Budget**

The Planner profile mentions a token budget per plan. Assuming this is something like "4000 tokens per plan proposal" or "total tokens for planning per hour = 100K," then:

```
Plan proposal 1: 3000 tokens
Plan proposal 2: 2500 tokens
Plan proposal 3: 2500 tokens (total: 8000)
Plan proposal 4: 3000 tokens
Rate limiter says: "Would exceed token budget, blocked"
```

**Stability at boundary:** Token budget is a **cost limiter**. It prevents the LLM interaction from becoming too expensive. If the rate limiter blocks due to token budget, it signals that Planning is consuming too much computational budget relative to available resources.

**Recommendation for monitoring:** Track which limiter is most frequently hit. If it's the plan creation rate (3/hour), the system is producing opportunities faster than Planning can handle. If it's the active plan limit (10), procedures are accumulating. If it's the token budget, the LLM calls are expensive. Each signals a different system bottleneck.

### 4.5 Rate Limiting Verdict

**Structural adequacy:** The three-dimensional rate limiting (creation rate, active count, token budget) is appropriate and covers the major resource dimensions.

**Parameter values:** The specific numbers (3/hour, 10 active, 4000 tokens/plan) are conservative and appropriate for a cold-start system. They can be tuned upward if the system matures and resources allow.

**Boundary behavior:** Graceful degradation at all boundaries. The system does not catastrophically fail when limits are reached; it pauses Planning and lets Opportunities decay.

**Stability:** The rate limiter is a negative feedback loop that prevents unbounded growth. It is stable under all tested scenarios.

---

## 5. Cold-Start Dampening Curve: Linear vs. Sigmoid Analysis

### 5.1 Current Design: Linear Ramp

```
dampening(n) = 0.8 * (1 - n / 100), where n = decision_count

At n=0:   dampening = 0.80 (80% of Opportunities suppressed)
At n=25:  dampening = 0.60 (60% suppressed)
At n=50:  dampening = 0.40 (40% suppressed)
At n=75:  dampening = 0.20 (20% suppressed)
At n=100: dampening = 0.00 (0% suppressed, normal operation)
```

### 5.2 ACT-R Confidence Growth for Comparison

For a typical procedure in the WKG:

```
confidence(count, hours) = base + 0.12 * ln(count) - d * ln(hours + 1)

At count=1 (first retrieval):   confidence ≈ base (ln(1) = 0)
At count=10:                    confidence ≈ base + 0.28
At count=50:                    confidence ≈ base + 0.49
At count=100:                   confidence ≈ base + 0.59
```

For LLM_GENERATED knowledge (base = 0.35):

```
count=1:   confidence ≈ 0.35
count=10:  confidence ≈ 0.63 (crosses retrieval threshold)
count=50:  confidence ≈ 0.84 (approaching Type 1 graduation)
count=100: confidence ≈ 0.94 (solidly Type 1)
```

**Key observation:** Confidence grows **logarithmically**. The first 10 successful uses double the gain. By 50 uses, significant competence is achieved.

### 5.3 Mismatch Analysis

Linear dampening assumes that **decision count is a direct proxy for system competence**. But ACT-R confidence depends on **retrieval count and time**, not decision count.

Consider two scenarios:

**Scenario A: Fast decisions, few retrievals**
- Decisions 1-100 happen in 10 minutes
- Average retrieval count per procedure: 2 (most procedures created early, not used often)
- By decision 100, average confidence ≈ 0.35 + 0.12 * ln(2) ≈ 0.42 (below retrieval threshold)
- Linear dampening: 0% at decision 100 (system treats it as competent)

**Mismatch:** System is still very immature, but dampening is already gone. Newly created procedures are weak (confidence 0.35) and immediately eligible for selection. Many low-quality procedures accumulate.

**Scenario B: Slow decisions, many retrievals**
- Decisions 1-100 happen over several hours
- Guardian provides feedback and confirmations
- Average retrieval count per procedure: 5
- By decision 100, average confidence ≈ 0.35 + 0.12 * ln(5) ≈ 0.54 (crosses retrieval threshold)
- Linear dampening: 0% at decision 100

**Match:** System is achieving basic competence. Dampening goes to zero at approximately the right time.

**Verdict:** Linear dampening is **decision-count-dependent**, not **competence-dependent**. It works if decisions come slowly and are richly evaluated. It breaks if decisions are rapid and sparse.

### 5.4 Proposed Sigmoid Alternative

```
dampening(n) = 0.8 * exp(-2 * (n / 100)^2)

At n=0:   dampening = 0.80
At n=20:  dampening ≈ 0.77
At n=40:  dampening ≈ 0.64
At n=60:  dampening ≈ 0.35
At n=80:  dampening ≈ 0.07
At n=100: dampening ≈ 0.001 (effectively 0)
```

**Characteristics:**
- Keeps dampening high (>0.7) through first 30% of cold-start (decisions 0-30)
- Smoothly transitions through middle phase (decisions 30-70)
- Approaching zero by decision 100

**Advantage:** The sigmoid curve matches known learning and development curves (Piaget's stage transitions, population growth, skill acquisition). It preserves high dampening where it's most needed (early phase when graph is weakest) and relaxes it as the system matures.

**Comparison to ACT-R:**

A sigmoid keeps dampening high while confidence is growing (decisions 0-50, average confidence still < 0.5). By decision 100, dampening is gone and average confidence is approaching 0.54. The timing is better matched.

### 5.5 Empirical Validation (Phase 1 Testing)

The linear vs. sigmoid question is an **empirical question**: Which curve produces better system behavior in practice?

**Prediction:**

With **linear dampening:** By decision 100, the WKG contains many weak procedures (confidence 0.35-0.50) created from sparse evidence in the cold-start phase. These clutter the decision space and compete for selection with better-grounded actions.

With **sigmoid dampening:** By decision 100, fewer weak procedures accumulate. The system focuses Planning on robust patterns only.

**Measurement:** At decision 100, examine the WKG:
- How many procedure nodes exist?
- What is the median confidence of procedures?
- How many are below retrieval threshold (0.50)?
- How many are above?

If linear produces significantly more untested low-confidence procedures, sigmoid is preferable.

### 5.6 Cold-Start Dampening Verdict

**Current design:** Linear ramp is **functionally adequate** but **suboptimal**.

**Recommendation for E8 implementation:**
1. Implement linear ramp as designed (lower implementation complexity)
2. Add monitoring at decision 100 to measure graph quality (procedure count, confidence distribution)
3. In Phase 1 post-integration (E10), if weak procedures accumulate (>20% below retrieval threshold), consider sigmoid for next iteration

**Theoretical grounding:** Sigmoid curves are well-established in developmental psychology (Piaget), learning theory (skill acquisition curves), and population dynamics (S-curves). A sigmoid ramp would be more theoretically grounded than the linear approximation.

---

## 6. Priority Queue Dynamics: Stability and Equilibrium

### 6.1 Queue Model

The Opportunity priority queue is implemented with:
- **Queue size limit:** 50
- **Decay function:** `P(t) = P₀ * (1 - 0.10)^(hours_in_queue)`
- **Decay half-life:** ~6.6 hours
- **Dequeuing policy:** FIFO by priority (highest priority dequeued first)

### 6.2 Equilibrium Analysis

At equilibrium, the rate of Opportunity creation equals the rate of processing plus decay:

```
Input rate (opportunities/hour) = Processing rate + Decay rate
F = λ * P + γ * O

Where:
F = prediction failure rate (opportunities/hour)
λ = planning throughput (plans created/hour) ≤ 3
P = number of procedures created from opportunities
γ = decay rate (opportunities lost to decay/hour)
O = queue depth
```

At steady state (dO/dt = 0):

```
O* = (F - λ*P) / γ
```

If we assume each opportunity has a 50% chance of being processed successfully:

```
λ*P ≈ 0.5 * F (half the opportunities result in plans)
O* = (F - 0.5*F) / γ = 0.5*F / γ
```

With γ = 0.10/hour:

```
O* = 0.5*F / 0.10 = 5*F
```

**Example equilibrium points:**

| Failure rate | Equilibrium queue depth | Queue status |
|--------------|------------------------|--------------|
| F = 2/hour | O* = 10 | Stable, well below max (50) |
| F = 5/hour | O* = 25 | Stable, near midpoint |
| F = 10/hour | O* = 50 | **At maximum** |

**Critical observation:** At F = 10 failures/hour, the queue is at maximum capacity. Any further increase in F causes queue saturation.

### 6.3 Saturation Dynamics

What happens when the queue fills?

```
Queue size > 50:
  1. New Opportunity arrives
  2. Enqueue with current priority
  3. Queue size now = 51
  4. Enforcement: "sort by priority, drop lowest"
  5. Lowest-priority Opportunity removed
  6. Queue size = 50 again
```

**Effect:** When F exceeds the decay-limited equilibrium, the lowest-priority opportunities are **discarded** to maintain the max size.

This is a **hard saturation**. The system cannot buffer more than 50 unprocessed opportunities. Excess opportunities are lost.

**Is this acceptable?**

It depends on the Opportunities being dropped:
- If they are duplicates or very low priority, dropping them is fine. The system has constrained the problem.
- If they are novel, high-impact patterns, dropping them means the system misses learning opportunities.

**Recommendation:** Add monitoring of **opportunity drops**. If opportunities are dropped regularly (more than once per session), the system is overwhelmed and the decay rate or planning throughput needs adjustment.

### 6.4 Oscillatory Behavior: Limit Cycles

The queue can exhibit **limit cycle behavior** if the failure rate is intermittent rather than steady:

```
Time 0-2h: F = 0 (no failures, system working well)
  Queue drains via decay
  Queue depth → 0

Time 2-4h: F = 10 failures/hour (burst, e.g., guardian introduces new topic)
  Queue fills rapidly: O = 50 within ~3h
  Planning creates plans (up to rate limit)
  Opportunities decay, but F > equilibrium, so queue stays full

Time 4-6h: F = 2 failures/hour (burst subsides)
  Queue drains via decay + processing
  Queue depth → 10

Time 6-8h: F = 0 (back to normal)
  Queue drains to 0

Cycle repeats
```

**Stability:** The system does not diverge (queue does not grow beyond 50). It cycles between "queue nearly full" and "queue nearly empty." The cycle period depends on failure rate dynamics.

**Is this concerning?**

Only if the oscillations are rapid and frequent. A slow cycle (failures in, then out, over hours or days) is normal adaptation. A rapid cycle (on/off every few minutes) would indicate instability.

**Monitoring:** Track queue depth over time. A plot should show:
- Steady state: queue hovering at equilibrium depth
- Burst adaptation: queue fills during burst, drains after
- Oscillation: regular periodic fill/drain pattern

If oscillations are chaotic or high-frequency, the decay rate may need tuning.

### 6.5 Empty Queue Risk

There is a risk that the queue becomes **too empty**, signaling insufficient Planning activity:

```
Queue depth = 0:
  No unprocessed opportunities
  Planning subsystem is idle
  This is good if the environment is stable
  This is bad if the environment is changing rapidly (Drift)
```

Empty queue is not a problem in itself. It means all detected opportunities have been either processed or decayed away. The question is: Is the system missing new patterns because it's not detecting them?

**Monitoring:** Correlate empty queue with prediction failure rate. If both are zero, the system is perfectly stable (ideal). If failure rate is high but queue is empty, opportunities are being dropped (saturation) or the evidence threshold is too high (no opportunities detected from failures).

### 6.6 Queue Dynamics Verdict

**Structural stability:** The priority queue with decay is stable across the expected operating range (F = 0 to 10 failures/hour).

**Equilibrium:** Reaches a stable equilibrium where queue depth ≈ 5*F.

**Saturation point:** At F = 10/hour, queue hits maximum (50). Beyond this, opportunities are discarded.

**Oscillation risk:** Low risk under normal operation. Possible slow cycles if environment changes burst/calm in episodic patterns (likely given a conversational system with a single guardian).

**Verdict:** **No fundamental stability issues.** The queue design is sound.

**Recommendations:**
1. Monitor opportunity drops (OPPORTUNITY_DROPPED events). Alert if > 1 per session.
2. Monitor queue oscillation frequency. If cycle period < 30 minutes, investigate.
3. Set a warning threshold: if queue depth > 40 for >1 hour, the system may be overwhelmed.

---

## 7. Emergent Dynamics: Cross-Subsystem Interaction

The Planning subsystem does not operate in isolation. It interacts with Learning (E7), Decision Making (E5), and Drive Engine (E4). Emergent dynamics arise from these couplings.

### 7.1 Planning ↔ Learning Feedback

**Loop:** Planning creates procedures → Decision Making tries them → Learning consolidates outcomes into the WKG

**Dynamics:**

```
Planning creates Procedure P at decision 100
  P has confidence 0.35, never tested

Decision Making encounters trigger context for P
  P is below retrieval threshold (0.50)
  **Decision Making cannot select P** (below threshold)

New Opportunity generated for same context
  Planning proposes another Procedure P2

Cycle: Planning creates procedures that Decision Making cannot use

...unless...

Decision Making has a mechanism to **trial new procedures**
  (Mentioned in Planner agent profile, not detailed)

If trial mechanism exists:
  P is selected with low probability (exploration)
  Outcome is observed
  Confidence updated: success or failure
  If success: confidence increases
  Multiple successes: confidence → retrieval threshold
  Learning consolidates: Procedure nodes are refined, edges created
  Procedure becomes more discoverable for future decisions
```

**Risk (Planner profile flags this):** Newly created procedures start below the retrieval threshold. **Decision Making must have a trial mechanism**, or new procedures are never tested and the system gets stuck with a static Type 1 repertoire.

**Cybernetic view:** This is an **intentional tension**. Low initial confidence prevents Decision Making from defaulting to untested procedures. But the tension requires a circuit breaker (trial mechanism) to resolve. Without it, the system becomes locked.

**Recommendation:** E5 (Decision Making) must specify the trial mechanism. Options:
1. **Occasional random selection:** Decision Making probabilistically selects new procedures (confidence-weighted exploration)
2. **Dedicated trial action:** An action node in the WKG that explicitly means "try an untested procedure" (meta-action)
3. **Initial confidence boost:** New procedures get a temporary confidence boost during a trial window, then settle to normal dynamics

Option 1 (probabilistic exploration) is most natural and requires no special mechanism. It's already implicit in most decision-making architectures.

### 7.2 Planning ↔ Decision Making Feedback

**Loop:** Decision Making selects actions → Outcomes feed back as prediction data → Planning detects failures and creates new procedures

**Dynamics:**

```
Decision Making has Type 1 reflexes: {walk, turn, speak, attend}
All trained on conversational scenarios with a single guardian

Guardian introduces new scenario type: multi-party interaction
  Sylphie's reflexes fail in novel contexts (low prediction accuracy)
  Prediction failures trigger Opportunities
  Planning creates procedures for multi-party coordination

Procedures are available to Decision Making
  Decision Making tries them (via trial mechanism or low confidence luck)
  Outcomes feed back: success or failure
  Confident procedures graduate to Type 1

New Type 1 repertoire includes multi-party behaviors

Next multi-party scenario: higher Type 1 hit rate
```

**Positive feedback:** Better procedures → higher Type 1 ratio → fewer Type 2 calls → faster response → better outcomes → higher satisfaction.

**Negative feedback:** Procedures are tested before use → failures demote them → unsuccessful procedures decay away.

The balance between positive and negative feedback determines whether Decision Making converges on useful procedures or cycles through failed attempts.

**Risk:** The Testing and Evaluation loop must be tight. If a procedure is created but never tried, or is tried once and immediately forgotten, the system cannot learn. If a procedure is tried once and immediately adopted (high confidence from single success), the system is overfitting.

**Cybernetic view:** This is a **classical learning loop**. It is stable if:
1. Evaluation is truthful (outcomes accurately reported)
2. Feedback is proportional (success/failure weighted appropriately)
3. Persistence is adequate (procedures are tried multiple times before being discarded)

All three conditions should be met by the ACT-R dynamics, but monitoring is essential.

### 7.3 Planning ↔ Drive Engine Feedback

**Loop:** Drive Engine detects Opportunities → Planning creates procedures → Procedures are executed by Decision Making → Execution results feed back to Drive Engine as drive effects

**Dynamics:**

```
Drive Engine: System Health drive = 0.5 (moderate)
  Prediction failures for basic self-maintenance tasks
  Creates Opportunity: "How to improve self-care"

Planning: Research and simulate
  Proposal: "When system load high, reduce exploration"
  Procedure created

Decision Making: Tries procedure when load high
  Effect: Reduced exploration
  Drive effects: System Health ↑ 0.1, Curiosity ↓ 0.2

Drive Engine evaluates:
  System Health improved (good)
  Curiosity suppressed (need to monitor)

Next opportunity: "How to maintain curiosity while managing load"
  Planning proposes: "Explore sparingly, prioritize targets"

Refinement cycle: Drive effects improve over iterations
```

**Positive feedback:** Procedures that improve drive satisfaction are used more → confidence increases → become Type 1 reflexes.

**Negative feedback:** Procedures that worsen drives are used less → confidence decreases → eventually decay away.

**Potential oscillation:** If two procedures have competing drive effects (one improves health, worsens curiosity; the other does the opposite), the system could oscillate between them.

**Example:**
- Procedure A: "Focus on learning" → Curiosity ↑, Satisfaction ↑, Anxiety ↑
- Procedure B: "Rest" → Anxiety ↓, Satisfaction ↑, Curiosity ↓

Decision Making alternates between A and B depending on current drive state. The system cycles between engaged and resting modes.

**Is this a problem?** No, if the cycling is adaptive (cycles when drives are in tension, settles when they align). Yes, if cycling is constant and prevents convergence to any stable behavior pattern.

**Monitoring:** Track which procedures are selected over time. If the same two procedures alternate rapidly, it might indicate drive system oscillation. If selection is diverse and procedures settle into steady use patterns, the system is healthy.

### 7.4 Planning ↔ Learning ↔ Decision Making Three-Way Coupling

All three subsystems interact through the WKG:

```
Planning creates Procedure nodes
  (action nodes in the WKG with high specificity)

Learning consolidates experience into generic knowledge
  (schema nodes in the WKG with general applicability)

Decision Making queries the WKG for action candidates
  (retrieves both procedures and generic actions)

Tension:
  Planning operates at high specificity: "In context X, do Y"
  Learning operates at lower specificity: "To achieve goal G, do Z"
  Decision Making needs both

Over time:
  Specific procedures (from Planning) should generalize into schemas (via Learning)
  Or they should remain specific if the context is reliably narrow

Risk:
  If Planning creates too many specific procedures, the WKG becomes cluttered
  If Learning abstracts too aggressively, useful specificity is lost
```

**Cybernetic view:** The three subsystems are trying to optimize different variables:
- **Planning** optimizes for adaptive response (create new behaviors fast)
- **Learning** optimizes for knowledge efficiency (abstract and generalize)
- **Decision Making** optimizes for action quality (select the best behavior available)

These can be in tension. A healthy system oscillates between specificity (Planning) and generality (Learning), driven by the demands of Decision Making.

### 7.5 Complexity Cascade Risk

Each subsystem addition increases the system's interactive complexity. The number of possible feedback loops grows combinatorially:

- 1 subsystem: 0 inter-subsystem loops
- 2 subsystems: 1 loop (A ↔ B)
- 3 subsystems: 3 loops (A ↔ B, B ↔ C, A ↔ C)
- 4 subsystems: 6 loops
- 5 subsystems: **10 loops** (including multi-hop cycles)

Add Planning to the system and the interactive complexity increases significantly. The system is now tightly coupled across Decision Making, Learning, Drive Engine, and Planning.

**Risk:** At this level of coupling, **emergent oscillations** or **phase transitions** become possible. A change in one subsystem can cascade through all others.

**Mitigation:**
1. **Intentional decoupling through shared stores.** Subsystems do not call each other; they read/write to TimescaleDB and WKG.
2. **Rate limiting and decay.** Every feedback loop has a negative feedback component (decay, rate limiting) that prevents unbounded growth.
3. **Monitoring.** Observe the system for oscillations, phase transitions, or unexpected bifurcations.

### 7.6 Emergent Dynamics Verdict

**Risks identified:**
1. **Planning-Learning oscillation:** If planning creates too many procedures faster than learning can generalize them, the WKG becomes cluttered and query performance degrades.
2. **Planning-Decision Making stall:** If Decision Making cannot trial new procedures (no trial mechanism), planning creates untestable procedures.
3. **Drive system oscillation:** If procedures have competing drive effects, the system alternates between them without settling.
4. **Complexity cascade:** At the coupling level of five subsystems, unexpected phase transitions are possible.

**Mitigations in place:**
1. Cold-start dampening and rate limiting prevent planning from overwhelming the system
2. ACT-R confidence dynamics ensure procedures are tested and evaluated before adoption
3. Drive rules and behavioral contingencies are designed to balance competing drives
4. Shared stores provide intentional decoupling

**Recommendation:** E8 implementation must ensure that Planning integrates cleanly with the existing four subsystems. E10 (integration testing) must include multi-subsystem stability checks: oscillation detection, phase transition monitoring, cascade failure testing.

---

## 8. Stability Recommendations: Mechanisms for Homeostasis

### 8.1 Homeostatic Variables for Planning

Sylphie's homeostasis depends on maintaining several variables within acceptable ranges:

**Essential variables for Planning subsystem:**

1. **Opportunity queue depth:** Should remain below 40 (warning threshold)
2. **Prediction failure rate:** Should trend toward stability as graph matures
3. **Plan success rate:** Proportion of created plans that improve prediction accuracy
4. **Procedure count:** WKG action nodes from Planning should not exceed 50-100 in Phase 1
5. **Plan confidence distribution:** Procedures should progressively graduate from 0.35 to higher confidence

### 8.2 Feedback Mechanisms for Homeostasis

**Mechanism 1: Rate Limiting as a Regulator**

Current design: Hard ceiling at 3 plans/hour.

**Enhancement:** Make the ceiling adaptive:

```
effective_rate_limit = 3 * (1 - queue_depth / 50)

If queue_depth < 25: limit = 3 plans/hour (normal)
If queue_depth = 30: limit = 2.1 plans/hour (slowing)
If queue_depth = 40: limit = 1.2 plans/hour (throttling hard)
If queue_depth = 50: limit = 0 (stop)
```

This converts the rate limiter from a **fixed threshold** to a **responsive regulator**. The faster the queue fills, the harder the system brakes.

**Advantage:** More stable than binary on/off. The system responds proportionally to stress.

**Disadvantage:** More complex to implement and reason about.

**Recommendation:** Implement the fixed version for E8. Add adaptive variant as an optimization in later iterations if queue oscillations are observed.

**Mechanism 2: Opportunity Decay as a Sink**

Current design: Exponential decay with 10%/hour rate.

**Enhancement:** Make decay rate adaptive based on queue depth:

```
decay_rate = 0.10 + 0.05 * (queue_depth - 25) / 25

If queue_depth < 25: decay = 0.10 (normal)
If queue_depth = 37: decay = 0.14 (accelerating decay)
If queue_depth = 50: decay = 0.20 (aggressive decay)
```

**Effect:** The fuller the queue, the faster opportunities disappear. This acts as an automatic pressure relief.

**Recommendation:** Same as above. Implement fixed version for E8. Consider adaptive variant for optimization.

**Mechanism 3: Cold-Start Transition as a Phase Change**

Current design: Linear ramp from 0.80 to 0.00 dampening over 100 decisions.

**Enhancement:** Make the transition explicit:

```
if decision_count < 50:
  dampening = 0.8 (heavy suppression, cold start)
else if decision_count < 100:
  dampening = 0.4 (partial suppression, ramp phase)
else:
  dampening = 0 (normal operation)
```

This creates **three phases:**
1. **Cold start (0-50):** Planning is heavily suppressed. Only the strongest patterns trigger planning.
2. **Ramp (50-100):** Planning gradually activates as the graph develops competence.
3. **Mature (100+):** Planning operates normally.

**Advantage:** More aligned with developmental theory (Piaget's stage transitions are phase-like, not linear).

**Disadvantage:** Arbitrary phase boundaries.

**Recommendation:** Consider for E8 or E10, depending on empirical testing.

**Mechanism 4: Plan Quality Metrics as Feedback**

Implement monitoring on plan success rate:

```
For each created plan P:
  Track: execution_count, success_count, failure_count
  Compute: success_rate = success_count / execution_count

Quality threshold: success_rate > 0.60

If 80% of plans have success_rate < 0.60:
  Evidence: Planning is creating low-quality procedures
  Response options:
    a) Tighten evidence threshold (require more failures before opportunity)
    b) Increase constraint validation strictness
    c) Increase cold-start dampening
    d) Alert guardian to investigate
```

**Cybernetic function:** Negative feedback on plan quality. If plans are poor, the system adjusts the planning pipeline to be more conservative.

**Recommendation:** Implement this monitoring for E10 (integration testing). Add to Drift Detection framework.

### 8.3 Circuit Breakers for Pathological States

Beyond homeostatic feedback, implement explicit circuit breakers for known attractor states:

**Circuit Breaker 1: Planning Runaway Detection**

```
if queue_depth > 40 AND plan_creation_rate >= 3 AND failure_rate > 5:
  // Planning Runaway suspected
  // Increase dampening, reduce rate limit
  coldStartDampening += 0.1  // increase suppression
  planningRateLimit = Math.floor(planningRateLimit / 2)  // cut throughput
  eventService.record('CIRCUIT_BREAKER_PLANNING_RUNAWAY')
  // Governor overrides normal parameters until conditions normalize
```

**Circuit Breaker 2: Prediction Pessimist Detection**

```
if decision_count < 100 AND procedure_count > 30:
  // Too many procedures created too early
  // Evidence: system is accumulating weak procedures
  coldStartDampening = 0.8  // reset to maximum suppression
  proceduresCreatedThisColdStart = procedure_count
  eventService.record('CIRCUIT_BREAKER_PREDICTION_PESSIMIST')
```

**Circuit Breaker 3: Quality Degradation**

```
let recentPlanSuccessRate = computeSuccessRate(last_10_plans)
if recentPlanSuccessRate < 0.40:
  // Plans are failing consistently
  // Stop creating new plans until quality improves
  planningRateLimit = 0  // halt planning entirely
  increaseEvidenceThreshold(from: 2, to: 3)  // require more evidence
  eventService.record('CIRCUIT_BREAKER_PLAN_QUALITY_FAILURE')
```

**Recommendation:** Implement Runaway and Pessimist circuit breakers for E8. Quality degradation circuit breaker for E10.

### 8.4 Monitoring and Telemetry

For the Planning subsystem to remain homeostatic, it needs continuous observation:

**Key metrics to monitor (per session and over time):**

| Metric | Healthy Range | Warning | Critical |
|--------|---------------|---------|----------|
| Queue depth | < 10 | 10-30 | > 40 |
| Plan creation rate | 0.5-2/hour | 2-3/hour | 3/hour (capped) |
| Plan success rate | > 0.60 | 0.40-0.60 | < 0.40 |
| Procedure count | 5-30 | 30-50 | > 50 |
| Average procedure confidence | 0.40-0.50 | 0.30-0.40 | < 0.30 |
| Opportunity drops | 0 | 1-2/session | > 2/session |
| Cold-start dampening | 0.00 (after 100 decisions) | 0.00-0.20 (at 100) | 0.50+ (after 100) |

**Recommendation:** Implement telemetry collection for all metrics. Add to the Observatory/Dashboard (E9) for real-time visualization. Include in Drift Detection (CANON) framework.

### 8.5 Stability Recommendations Summary

**Immediate (E8):**
1. Implement rate limiting as designed (fixed 3/hour, 10 active, token budget)
2. Implement cold-start dampening with linear ramp (0.80 to 0.00 over 100 decisions)
3. Implement opportunity priority queue with exponential decay (10%/hour)
4. Implement monitoring infrastructure for key metrics

**Phase 1 (E10):**
1. Analyze cold-start dampening effectiveness. If weak procedures accumulate, consider sigmoid ramp variant.
2. Monitor queue depth and oscillation patterns. If queue oscillates rapidly or queues fill frequently, implement adaptive rate limiting.
3. Implement plan quality circuit breaker. Stop planning if success rate < 0.40.
4. Add Planning Runaway and Prediction Pessimist circuit breakers.

**Future optimization:**
1. Adaptive rate limiting (proportional to queue depth)
2. Adaptive decay rates (faster decay when queue is full)
3. Phase-based dampening (explicit cold start, ramp, mature phases)
4. Learning-based adjustment (tune parameters based on observed system dynamics)

---

## 9. Conclusion: Planning as a Requisite Variety Engine

### 9.1 Theoretical Summary

The Planning subsystem is a **variety amplifier** in Ashby's sense: it increases the system's behavioral repertoire in response to environmental demands. The CANON designs Planning as a closed-loop system:

1. **Input:** Recurring prediction failures (evidence of insufficient variety)
2. **Process:** Research, simulate, propose, validate, create procedures
3. **Output:** New action nodes in the WKG
4. **Feedback:** Procedure outcomes → confidence updates → decision making influence → next cycle

### 9.2 Stability Analysis Findings

**Positive Feedback (Plan Creation):**
- Controlled by rate limiting (3 plans/hour)
- Limited by cold-start dampening (80% suppression initially)
- Bounded by resource constraints (tokens, active plan count)
- Stable under expected operational conditions

**Negative Feedback (Opportunity Decay):**
- Exponential decay (10%/hour) prevents infinite accumulation
- Equilibrium queue depth ~5 × failure_rate
- Saturation point at queue_depth = 50
- Graceful degradation when saturation is reached

**Emergent Loops (Planning ↔ Learning, Planning ↔ Decision Making):**
- Tight coupling through WKG
- Stable if evaluation is truthful and feedback is proportional
- Risk: Procedures not tested (trial mechanism required)
- Risk: Learning-Planning oscillation if abstraction/specificity balance breaks

### 9.3 Key Risks and Mitigations

| Risk | Severity | Mitigation | Monitoring |
|------|----------|-----------|-----------|
| Planning Runaway | Medium | Rate limiting + decay + cold-start dampening | Queue depth, plan creation rate |
| Prediction Pessimist | Medium | Cold-start dampening + evidence threshold | Procedure count at decision 100 |
| Untested procedures | High | Trial mechanism in Decision Making | Procedure confidence distribution |
| Drive oscillation | Low | Drive balance + behavioral contingencies | Selection frequency, drive state |
| Learning-Planning cluttering | Low | Decay + generalization | WKG size, procedure count |

### 9.4 Design Adequacy

**Is the designed Planning subsystem adequate for Phase 1?**

**Yes, with caveats:**

1. **Rate limiting is adequate:** 3 plans/hour is conservative and prevents runaway in normal operation.
2. **Cold-start dampening is adequate but suboptimal:** Linear ramp works but sigmoid would better match development. Recommend monitoring and refinement in Phase 1 post-integration.
3. **Opportunity decay is adequate:** Exponential decay with 10%/hour is sound. Equilibrium is stable.
4. **Constraint validation is adequate:** LLM-based validation catches obviously bad plans.
5. **Integration points are sound:** Planning receives Opportunities from Drive Engine, creates procedures for Decision Making, uses WKG for research and storage, logs to TimescaleDB.

**Remaining questions for E8 implementation:**

1. **Trial mechanism for Decision Making:** Must Decision Making have an explicit trial mechanism to test new procedures? Or does probabilistic exploration suffice? → Coordinate with E5 (Cortex)
2. **Plan quality threshold:** At what success rate should plans be demoted or discarded? → Define in E8 or E10
3. **Cold-start threshold:** Is 100 decisions the right cold-start boundary? Or should it be adaptive based on graph confidence? → Test in E10
4. **Adaptive regulation:** Should rate limiting and decay be adaptive (respond to queue state)? Or fixed for simplicity? → Implement fixed for E8, optimize in E10

### 9.5 Recommendations for Implementation (E8) and Integration (E10)

**E8 (Planning Subsystem Implementation):**
1. Implement all five subsystems as designed (research, simulate, propose, validate, create)
2. Use fixed rate limiting (3/hour, 10 active, token budget)
3. Use linear cold-start dampening (0.80 to 0.00 over 100 decisions)
4. Implement exponential decay (10%/hour) on opportunity queue
5. Implement all monitoring metrics (queue depth, plan creation rate, success rate, etc.)
6. Clearly specify the trial mechanism requirement for Decision Making

**E10 (Integration Testing):**
1. Run cold-start phase (first 100 decisions) and analyze procedure accumulation. Does Prediction Pessimist appear?
2. Run novelty burst (rapid failures) and analyze queue behavior. Does Planning Runaway prevention work?
3. Run long-session (1000+ decisions) and analyze plan success rate. Are procedures improving or degrading?
4. Analyze cold-start dampening effectiveness. Compare linear vs. sigmoid ramp curves if data permits.
5. Analyze emergent Planning-Learning-Decision Making dynamics. Look for oscillation, phase transitions, or unexpected coupling effects.

### 9.6 Broader Systems Context

From a whole-system perspective, Planning is the subsystem that **closes the learn-predict-act loop**. Without Planning, Sylphie's behavioral repertoire is static (only what Learning captures from experience and Type 2 handles). With Planning, the system can deliberately **generate new behaviors** to address repeated failures.

The tension is intentional: Planning must create variety (positive feedback) while staying bounded (negative feedback through decay, rate limiting, dampening). The designed mechanisms are appropriate for this tension.

**Final verdict:** The Planning subsystem is **theoretically sound, structurally stable, and adequate for Phase 1 operation**. The emergent dynamics with other subsystems require monitoring and the cold-start dampening curve could be optimized, but neither is a blocker. The system should proceed to implementation with the recommended monitoring and Phase 1 testing.

---

## References

**Systems Theory:**
- Ashby, W. R. (1956). *An Introduction to Cybernetics*. Chapman & Hall.
- Ashby, W. R. (1952). *Design for a Brain*. Chapman & Hall.
- Beer, S. (1972). *Brain of the Firm*. Herder & Herder.

**Learning and Development:**
- Anderson, J. R., Bothell, D., Byrne, M. D., Douglass, S., Lebiere, C., & Qin, Y. (2004). An integrated theory of the mind. *Psychological Review*, 111(4), 1036-1060.

**Complexity and Emergence:**
- Kauffman, S. A. (1993). *The Origins of Order*. Oxford University Press.
- Maturana, H. R., & Varela, F. J. (1980). *Autopoiesis and Cognition*. Reidel.

**Sylphie Documentation:**
- CANON (wiki/CANON.md) -- architectural truth
- Roadmap (wiki/phase-1/roadmap.md) -- epic specifications
- Planner agent profile (.claude/agents/planner.md) -- implementation details

---

**Analysis Complete**
**Word Count:** ~8500
**Sections:** 9 major sections + executive summary
**Theoretical Framework:** W. Ross Ashby (cybernetics), requisite variety, feedback dynamics, attractor states, complexity cascades, emergent systems
**Methodology:** Dynamical systems analysis, equilibrium stability analysis, basin of attraction mapping, circuit breaker design

This analysis is provided to support Epic 8 implementation and serves as input for the canonical design validation process.
