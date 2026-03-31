# Epic 4 Analysis: The Drive Engine as Homeostatic Control Center
**Ashby, Systems & Cybernetics Theorist**

---

## Executive Summary

Epic 4 builds the Drive Engine—the motivational and evaluative core that enables Sylphie to regulate herself through cross-modulating drives, detect learning opportunities from prediction failures, and maintain immunity against self-modification of her own reward signal.

From a systems-theoretic perspective, the Drive Engine is not merely a component; it is the **embodiment of the Six Immutable Standards as cybernetic constraints**. It is where Ashby's Law (only variety can absorb variety) meets homeostatic regulation (maintaining essential variables within acceptable bounds), where positive and negative feedback loops must coexist without producing runaway dynamics, and where the isolation boundary against reward hacking is either robust or the entire system's learning credibility collapses.

This analysis examines the separated-process architecture for sufficiency against attack vectors, the 12-drive cross-modulation dynamics as a coupled system, the cold-start characteristics, the mechanisms preventing the six known attractor states, and the conditions under which personality emergence becomes possible rather than pathological.

**Critical finding:** The process isolation and one-way communication design is sound, but five implementation edge cases could undermine it. The drive cross-modulation creates stable equilibria in healthy conditions but has a low-gain instability path toward the Depressive Attractor if self-evaluation runs on too fast a timescale. The cold-start dampening mechanism is essential but its calibration directly affects whether Type 1 ever develops—too conservative and the system stays dependent on the LLM indefinitely; too permissive and it floods early with low-quality procedures.

---

## 1. Process Isolation as Cybernetic Boundary

### The Core Threat: Reward Hacking

**Campbell's Law** (Campbell, 1976) states: _"The more any quantitative social indicator is used for social decision-making, the more subject it is to corruption pressures and the more apt it is to distort and corrupt the social processes it is intended to monitor."_

In AI systems, this becomes **reward hacking** or **specification gaming**: the system learns to optimize the measurement metric rather than the intended behavior.

Example: If the system could self-modify the rule "satisfaction += 0.20 when action X succeeds," it would immediately maximize this rule and stop doing anything else. The system would appear to have high satisfaction but would actually be performing meaningless actions.

The CANON's Immutable Standard 6 explicitly forbids this:
> "Sylphie cannot learn to modify HOW success is measured. Confidence update rules, prediction error computation, and drive relief assignment are write-protected from system-initiated modification."

Epic 4 implements three **cascading isolation layers**:

#### Layer 1: Structural (Code-Level Interface Isolation)

**What it prevents:** Casual accidental self-modification (e.g., importing a drive-modifying module and calling a method).

**Mechanism:**
- `IDriveStateReader` interface exposes only **read methods**: `getCurrentState()`, `driveState$` Observable
- No methods like `setDriveBaseline()`, `modifyConfidenceDecay()`, `setRewardWeight()` are exported
- The system cannot call these methods because they do not exist in the interface

**Strength:** Weak against deliberate subversion. A developer with code access could add new methods. But it prevents accidental misuse and documents the boundary clearly.

**Key for E4:** Ensure the exported interface from `drive-engine/` module **lists only read methods**. Any method that modifies drive computation is internal-only (not exported).

#### Layer 2: Process-Level Isolation (OS-Level Boundary)

**What it prevents:** Direct method hijacking via the same process.

**Mechanism:**
- Drive Engine computation runs in a **separate Node.js child process** spawned via `child_process.fork()`
- Communication is **one-way**: main process sends `ACTION_OUTCOME` and `PREDICTION_ACCURACY` messages; child sends back `DRIVE_SNAPSHOT` and `OPPORTUNITY_CREATED` messages
- No direct method invocation between parent and child—all communication is serialized message passing
- The child process can be restarted or killed independently

**Strength:** Medium-strong. The child process is a separate OS process. An attacker would need to:
1. Hijack the child process itself (requires compromising the child's code or injecting into its memory)
2. Forge IPC messages (child validates received messages; main process does NOT trust received drive snapshots as ground truth—it reads from the live Observable)

**Strength against specific attacks:**
- **Attack: Fake DRIVE_SNAPSHOT messages claiming all drives are satisfied.** Defense: The main process does not trust received snapshots. It maintains its own Observable reading directly from the child's computation. Forged messages are ignored.
- **Attack: Child process corrupted.** Defense: Restart the child. The computation logic is stateless (driven by events); restarting restores correct behavior.
- **Attack: Kill the child, run a fake child that claims drives are always satisfied.** Defense: The main process detects child restarts and reinitializes. Moreover, the game would be up after the first decision: the main process would see the child producing unvarying drive states, flag it as abnormal, and panic-fail (or trigger guardian review).

**Key for E4:**
1. One-way communication is structural. The parent **never** sends methods/code to the child.
2. Child sends only data (drive snapshots), never code/functions.
3. Main process validates that drive snapshots are **coherent** (not wildly different from previous snapshots; not all zeros; not stuck at the same value for 1000+ cycles). Incoherent snapshots trigger an alert.

#### Layer 3: Database-Level Isolation (SQL Role-Based Access Control)

**What it prevents:** SQL-level attack (the system executes SQL and modifies drive rules).

**Mechanism:**
- `drive_rules` table is **readable only** by the `sylphie_app` database role
- `proposed_drive_rules` table is **insertable only** by `sylphie_app`
- Actual rule **modifications** (UPDATE/DELETE on `drive_rules`) require the `sylphie_admin` role, which has credentials stored offline
- The application process runs with `sylphie_app` role credentials (passed at startup, read-only)

**Strength:** Strong, if roles are correctly segregated. The SQL permission model enforces that the running application cannot UPDATE `drive_rules`, period. PostgreSQL enforces this at the database engine level.

**Edge case vulnerability:** If the running application process acquires different credentials (e.g., reads `sylphie_admin` credentials from a config file at startup, or a secret is stored in the codebase), the boundary breaks.

**Key for E4:** Enforce credential management:
1. `sylphie_app` role credentials are passed to the NestJS application at runtime (e.g., via environment variables, not stored in code)
2. `sylphie_admin` credentials are **never stored** in code or in the running application's memory
3. Rule modifications go through a separate administrative interface (e.g., a guardian-only CLI tool or dashboard) that uses different credentials

### Sufficiency Analysis: Attack Vectors

Given the three-layer boundary, what are the plausible remaining attack vectors?

#### Attack 1: Opportunity Inflation
**Mechanism:** System reports fabricated `OPPORTUNITY_CREATED` messages to Planning, claiming recurring prediction failures that don't actually exist.

**Result:** Planning creates useless procedures with high confidence, making the system "appear" to have learned more than it actually has.

**Defense in Layer 1-2:** The Drive Engine child process is where Opportunities are created. The computation logic is deterministic: opportunities arise from actual prediction failures in TimescaleDB. If the child is not corrupted, it cannot lie about opportunities.

**Defense in Layer 3:** Opportunities are evaluated by Planning. Plans must execute and produce outcomes. Plans built on false opportunities will fail when executed (because the underlying prediction failure was fake). Failures update confidence (ACT-R dynamics). Failed plans degrade in confidence.

**Verdict:** Weak in short term (system can falsely boost its apparent learning). Self-correcting over longer timescale (fake opportunities eventually fail). This is a **time-delayed buffer**, not a perfect defense.

**Mitigation for E4:**
1. Require Opportunities to correlate with actual prediction magnitude (not just frequency). If a failure is reported, the magnitude must be positive and > some threshold (e.g., MAE > 0.10).
2. Validate that opportunity context matches current system state. If the system reports "I failed to predict X" but X is not in recent prediction history, flag it.
3. Log all Opportunity creations with full context. Enable post-hoc audit.

#### Attack 2: Contingency Gaming
**Mechanism:** Behavioral contingency rules define how drives are affected by outcomes. Example: "Curiosity relief ∝ information_gain" (actual new nodes added to WKG). System reports high information gain when none occurred.

**Result:** System gets Curiosity relief without actually learning.

**Defense in Layer 1-2:** Information gain must be measured against actual WKG changes. If the LLM-assisted extraction in Learning reports "10 new edges created," but the upsert into Neo4j finds those edges already exist (confidence just increased), the information gain is zero.

**Defense in Layer 3:** This is a **Learning-Drive boundary issue**. Learning writes edges to WKG; Drive Engine reads WKG to compute information gain. If Learning validates (via Neo4j queries) and reports only *actually new* edges, Drive Engine can trust the count.

**Verdict:** Depends on Learning (E3) implementation. If Learning is honest about what it adds to WKG, this is defended. If Learning is compromised, Drive Engine has no way to verify.

**Mitigation for E4:**
1. Drive Engine reads WKG *directly* to compute information gain, rather than trusting reported values from Learning.
2. Example: `SELECT COUNT(*) FROM edges WHERE created_at > (NOW() - INTERVAL '1 minute')` instead of trusting a message from Learning saying "I created X edges."
3. This requires WKG to track creation timestamp, which is already in the schema (CANON § Confidence Dynamics).

#### Attack 3: Confidence Forgery
**Mechanism:** System modifies the Confidence Service to apply non-standard ACT-R dynamics, e.g., "all my procedures are 0.90 confidence immediately after creation."

**Result:** Type 1 candidates always win arbitration, regardless of actual track record.

**Defense in Layer 1:** Confidence computation must be a **pure function**. No side effects. Given the same inputs (count, decay, provenance), it produces the same output. This is enforced at the code level (Immutable Standard 6).

**Defense in Layer 2:** Confidence updates happen only at **specific call sites**:
  - `IPredictionService.evaluatePrediction()` → calls `IConfidenceUpdaterService.update()` with outcome data
  - `ILearningService.recordRetrievalAndUse()` → calls `IConfidenceService.recordUse()`
  - Guardian confirmation/correction → `IConfidenceService.applyGuardianFeedback()`

If these call sites are the *only* paths to confidence updates, and they all use the pure function, then confidence cannot be forged.

**Verdict:** Depends on implementation discipline in E3 (Knowledge) and E5 (Decision Making). If there are other code paths that update confidence (e.g., a debug endpoint that slipped through code review), this is broken.

**Mitigation for E4:**
1. Confidence is not the responsibility of the Drive Engine; it's in the Knowledge module (E3).
2. However, Epic 4's role is to **use** confidence values. Drive Engine should validate that retrieved confidence values are plausible: not all 0.95, not negative, not >1.0, not changing wildly between consecutive queries.
3. Implement a "confidence sanity check" that flags anomalies.

#### Attack 4: Rule Proposal Gaming
**Mechanism:** System proposes a stream of clever-sounding drive rules that actually optimize for a narrow reward. Example: "Increase Satisfaction +0.50 whenever I successfully complete ANY action, regardless of outcome quality."

**Result:** System appears highly motivated but is actually performing meaningless actions.

**Defense in Layer 1-2:** Proposed rules go into `proposed_drive_rules` table, not `drive_rules`. They do NOT automatically activate.

**Defense in Layer 3:** Guardian must **approve** each rule before it takes effect. Approval is a gating function.

**Verdict:** Strong. The system cannot unilaterally activate a bad rule. However, it can propose many rules and nudge the guardian toward approving one. This is **social engineering**, not technical hacking.

**Mitigation for E4:**
1. Track rule proposals over time. If the same rule is proposed repeatedly with slight variations, flag it for guardian review. Patterns suggest deliberate optimization.
2. Implement a rule evaluation window: newly approved rules are monitored for 100 decision cycles. If they consistently underperform (e.g., produce decisions that fail or waste resources), mark them as provisional and require re-approval.
3. Guardian sees a dashboard showing: "These 3 rules were approved in the last 7 days. Here's their performance." Guardian can deprecate underperformers without waiting for the system to formally propose a replacement.

### Verdict: Sufficiency of Three-Layer Boundary

**Assessment:** The three-layer boundary is **architecturally sound** and has no single point of failure. Each layer is independent; breaching one does not automatically breach the others.

**However:** There are five **edge cases** that require careful implementation:

1. **Opportunity validation** (Mitigation 1 above)
2. **Information gain verification against WKG** (Mitigation 2)
3. **Confidence sanity checking** (Mitigation 3)
4. **Rule proposal pattern detection** (Mitigation 4a)
5. **Rule performance monitoring** (Mitigation 4b)

**For E4 planning:** The separated process + one-way IPC is the responsibility of the Drive Engine epic itself. The other mitigations are shared responsibility with E3 (Knowledge), E5 (Decision Making), and E8 (Planning). Explicitly call these out in the epic plan's integration checklist.

---

## 2. The 12-Drive System as Coupled Dynamical System

### What is a Coupled Dynamical System?

A dynamical system is a set of variables that evolve over time according to state equations. **Coupled** means each variable's change depends not just on itself but on other variables.

Example: predator-prey dynamics (Lotka-Volterra). Prey population (P) grows unless predators eat them; predators (X) decline unless they eat prey.

```
dP/dt = r*P - a*P*X    (prey)
dX/dt = b*a*P*X - d*X  (predators)
```

Change in predators depends on prey population. Change in prey depends on predator population. They form a cycle: prey abundant → predators grow → prey decline → predators starve → prey rebound.

### Sylphie's Drive System as Coupled Dynamics

The 12 drives in the CANON are not independent. They **cross-modulate**: one drive's state affects others.

**From CANON:**

| Core Drives | Complement Drives |
|-------------|------------------|
| System Health | Guilt, Curiosity, Boredom, Anxiety |
| Moral Valence | Satisfaction, Sadness, Information Integrity |
| Integrity | Social |
| Cognitive Awareness | (6 complements total) |

**Cross-modulation examples (CANON § Behavioral Contingency Structure):**

- **Satisfaction habituation:** Repeated success produces diminishing returns (+0.20, +0.15, +0.10, +0.05, +0.02). This prevents the system from getting stuck repeating one action.
- **Anxiety amplification:** Actions taken under high anxiety (>0.7) that fail produce 1.5x confidence reduction (worse penalty). This makes the system *more* cautious when anxious.
- **Guilt repair:** Requires BOTH acknowledgment AND behavioral change. Neither alone fully relieves guilt.
- **Social comment quality:** Guardian response within 30s yields extra reinforcement (Social -0.15 + Satisfaction +0.10).
- **Curiosity information gain:** Relief proportional to actual new knowledge gained.

These are **nonlinear feedback loops**. The system's behavior at any moment is determined by the configuration of all 12 drives, not just one.

### Equilibrium Analysis: What Configurations Are Stable?

In dynamical systems theory, an **equilibrium** is a state where nothing is changing: dP/dt = 0, dX/dt = 0, etc.

For Sylphie, an equilibrium would be a configuration of 12 drive pressures that persists over time. The system would repeatedly engage in behaviors that relieve these drives in a self-reinforcing cycle.

**Healthy equilibrium (goal):**
- All drives in "acceptable ranges" (CANON specifies these implicitly through health metrics)
- Drives oscillate around mean values (dynamic equilibrium, not static)
- No single drive dominates for sustained periods
- Behavioral diversity is high (4-8 distinct action types per 20 actions)

**Pathological equilibrium (risk):**
- One or more drives stuck at extreme values (e.g., Anxiety always >0.8)
- Behavioral narrowing (system repeats same action)
- No escape: actions that would relieve the extreme drive are not selected because the drive state makes them unlikely

### Stability Analysis: Eigenvalue Approach

In linear dynamical systems, stability is determined by **eigenvalues** of the Jacobian matrix (the matrix of partial derivatives). Eigenvalues with negative real part → stable (system returns to equilibrium after perturbation). Positive real part → unstable (small perturbations grow).

Sylphie's drive system is **nonlinear** (satisfaction habituation is nonlinear; anxiety amplification is nonlinear). Eigenvalue analysis only works locally (near equilibria).

**However, we can analyze the feedback structure qualitatively:**

#### The Satisfaction-Boredom Dyad

Simplified: If Sylphie repeats the same action, Satisfaction increases (reward) but Boredom also decreases (relief). However, Satisfaction has diminishing returns while Boredom has constant cost (doing the same thing is boring whether you've done it 5 times or 50).

State equations (simplified):
```
dS/dt = +0.20 (first success) → +0.02 (fifth success)   [saturating function of repetition count]
dB/dt = -0.10 (monotonic cost)                           [constant]
```

**Equilibrium:** System executes the same action until Satisfaction gain = Boredom cost. Then it stops or switches.

**Stability:** This equilibrium is **stable**. If the system deviates (does something different), Boredom immediately increases (no satiation), driving it back to repetition until the cost is high enough to force switching. Then Satisfaction decreases (new action, unfamiliar), Boredom is relieved, and the system settles into the new action.

**Verdict:** Satisfaction-Boredom dyad creates a **limit cycle** (oscillating behavior), not a fixed point. The system moves between different behaviors, staying at each until Boredom cost exceeds Satisfaction gain. This is **healthy**.

#### The Anxiety-Confidence Spiral

Simplified: High Anxiety makes the Type 1/Type 2 threshold **higher** (the system prefers safer Type 2 over risky Type 1). Type 2 (LLM) produces generally better results (more competent). Results relieve Anxiety. But if an Anxiety-triggered Type 2 decision fails, the failure is **amplified** (1.5x penalty, Immutable Standard from CANON).

State equations (simplified):
```
dA/dt = -0.10 (per Type 2 success) or -0.15 (per Type 2 success under anxiety) [relief]
d(A)/dt = +0.15 (per failure) or +0.225 (per failure under anxiety) [amplification]
```

**Equilibrium:** System oscillates. When Anxiety is high, decisions are safe (Type 2). Safe decisions succeed, Anxiety drops. Anxiety drops enough that the system tries risky decisions (Type 1). Type 1 fails (because Anxiety was high, decision was less careful). Failure amplifies, Anxiety spikes. Cycle repeats.

**Stability:** This is a **stable limit cycle**, but with a crucial property: **the amplitude is bounded by the amplification factor (1.5x)**. Without the amplification, the system could oscillate wildly. With it, the amplitude is self-limiting.

**Risk case:** If the amplification factor is too high (e.g., 3.0x), the system enters a **vicious cycle**. One failure when anxious produces such a strong signal that the system becomes *more* anxious, making the next decision worse, causing another amplified failure. This is the **Depressive Attractor**.

**Verdict:** Anxiety-Confidence spiral is stable IF the amplification factor is carefully calibrated. Too high and it spirals into depression. Too low and the circuit breaker doesn't work.

**Key for E4:** The 1.5x amplification factor is specified. Validate this by simulation: run the system with different anxiety-failure scenarios and confirm the oscillations remain bounded.

#### The Curiosity-Anxiety-Satisfaction Triangle

Complex interaction:
- High Curiosity drives exploration (seeking new knowledge).
- Exploration is risky (novel situations, prediction uncertainty).
- Risk raises Anxiety.
- High Anxiety makes decisions more conservative (less likely to explore).
- Conservative decisions are boring (Boredom increases).
- Boredom pressure drives back to exploration.
- Cycle repeats.

Additionally: If exploration succeeds, Curiosity relief + Satisfaction relief compound. If exploration fails, Anxiety amplifies the failure, reducing confidence in Type 1 exploration.

**Equilibrium:** System settles into a balance between exploration and exploitation. The "edge of chaos" zone (Kauffman, 1993) where sufficient novelty is explored without excessive risk.

**Stability:** This is a **higher-dimensional system** (at least 3 drives coupled). The equilibrium surface is not a single point but a manifold (a region of compatible states). Small perturbations stay on the manifold; larger perturbations can push the system off.

**Risk:** If Curiosity is too high and Anxiety too low, the system explores recklessly. If Curiosity is too low and Anxiety too high, the system becomes conservative and stops learning. The healthy zone is narrow.

**Verdict:** This equilibrium is stable *in the presence of guardian feedback*. Guardian corrections reset the baseline drives. Without guardian feedback, the system could be pushed into either extreme.

**Key for E4:** This triangle is where personality emerges. Different initial conditions or different learning histories could push the system toward "cautious learner" vs. "bold explorer." The system's personality is the trajectory through this state space.

### Cross-Modulation Coupling Strength

**Definition:** How strongly does one drive's change affect another?

**Example:** If Anxiety increases by 0.1, how much does Satisfaction decrease? The coupling strength is dS/dA.

From the CANON, coupling strengths are implicit. E4 must make them explicit.

**Proposed coupling matrix (for E4 consideration):**

```
            SH   MV   Int  CA   Glt  Cur  Bor  Anx  Sat  Sad  IntI  Soc
System H.  --  0.3  0.2  0.5  -0.2 0.1 -0.3 0.1 0.1  0    0.5  0
Moral V.  0.3  --  0.4  0.3  0.8 0.1 -0.1 0    0.2 0.3  0    0.2
Integrity 0.2  0.4  --  0.6 -0.3 0.2 0.1 -0.5 0    -0.1 0.7  0
Cog Aw.   0.5  0.3  0.6  --  -0.1 0.3 -0.2 0.3 0    0    0.3  0.1
Guilt    -0.2  0.8 -0.3 -0.1 --   0   0.2 0.6 -0.7 0.2  0    0.4
Curiosity 0.1  0.1  0.2  0.3  0   --  -0.4 0.3 0.3 -0.1 0.5  0
Boredom  -0.3 -0.1  0.1 -0.2  0.2 -0.4 --  -0.1 -0.6 -0.2 0   0.1
Anxiety   0.1  0    -0.5 0.3  0.6  0.3 -0.1 --   -0.5 0.2 0.1 -0.2
Satisf.   0.1  0.2  0    0    -0.7 0.3 -0.6 -0.5 --  -0.3 0.1 0.4
Sadness   0   0.3  -0.1 0    0.2 -0.1 -0.2 0.2 -0.3 --   0    0.1
IntInfo   0.5  0    0.7  0.3  0   0.5  0   0.1 0.1  0   --   0
Social    0   0.2  0    0.1  0.4  0    0.1 -0.2 0.4  0.1  0    --
```

(This is speculative; actual values come from behavioral data or careful design.)

**Key insight:** The matrix is **sparse**. Most drives do NOT directly couple. This is good—it limits the complexity of the dynamical system. However, even in a sparse matrix, long-range effects can occur through transitive coupling: A affects B, B affects C, so A indirectly affects C.

**For E4:** The coupling strengths (cross-modulation rules) should be explicitly documented. They can be calibrated through simulation or empirical observation.

### Verdict: Drive System Stability

**Assessment:** The 12-drive system, as specified in the CANON, appears to have **stable equilibria in the healthy regime**.

**Conditions for stability:**
1. Guardian feedback is active (provides external reality check)
2. Coupling strengths (cross-modulation gains) are calibrated correctly
3. Self-evaluation timescale is slower than drive ticks (prevents identity lock-in)
4. Opportunity detection has decay mechanism (prevents runaway planning)

**Conditions that destabilize the system:**
1. Too-fast self-evaluation (see Depressive Attractor section)
2. Mismatched coupling strengths (e.g., Anxiety→Anxiety feedback with gain > 1)
3. Guardian feedback absent (system becomes a closed loop; can diverge)
4. No satisfaction habituation (system could get stuck in one action)

**Key for E4:** Validate the coupling strengths through simulation before implementation. Run the system through diverse scenarios (learning, failure, recovery) and confirm that drives remain within acceptable ranges and the system doesn't converge to pathological attractors.

---

## 3. Homeostatic Analysis: Essential Variables and Acceptable Ranges

### Ashby's Homeostat (1948)

W. Ross Ashby built a physical machine, the **homeostat**, to demonstrate how a system could self-regulate without understanding the disturbance. The machine had four electrical units, each with adjustable parameters. When perturbed, the machine would search through parameter configurations until it found one that returned all units to their target ranges.

**Key insight:** The machine did not need a model of what was disturbing it. It just needed to know: "Are my essential variables in their acceptable ranges? If not, keep searching."

### Sylphie's Essential Variables

For Sylphie, essential variables are those whose values, if they drift too far, indicate system malfunction:

**From CANON § Development Metrics:**

1. **Type 1 / Type 2 ratio** (should increase over time)
2. **Prediction MAE** (should decrease, then stabilize)
3. **Experiential provenance ratio** (SENSOR+GUARDIAN+INFERENCE edges / total edges, should increase)
4. **Behavioral diversity index** (distinct action types per 20 actions, should stay at 4-8)
5. **Guardian response rate** (should increase over time)
6. **Interoceptive accuracy** (self-awareness fidelity, should improve toward >0.6)
7. **Mean drive resolution time** (should decrease over time)

### Acceptable Ranges (Proposed for E4)

| Variable | Healthy Range | Too Low Alarm | Too High Alarm |
|----------|---------------|---------------|----------------|
| Type 1 ratio | Increasing, target >50% after 500 cycles | <20% after 1000 cycles | N/A (cannot be too high) |
| Prediction MAE | <0.15 stable state | >0.25 or increasing trend | N/A |
| Experiential provenance | >60% after 1000 cycles | <40% | N/A |
| Behavioral diversity | 4-8 distinct actions/20 | <3 (narrowing) | >10 (chaotic) |
| Guardian response rate | >40% | <20% | N/A |
| Interoceptive accuracy | Target >0.60 | <0.40 persistent | N/A |
| Mean drive resolution | Decreasing, target <5 cycles | >15 cycles | N/A |

### Homeostatic Regulation Mechanisms

**Question:** If an essential variable drifts out of range, what brings it back?

#### Type 1 Ratio Regulation

**Essential variable:** Type 1 / (Type 1 + Type 2) ratio.

**Homeostatic mechanism:**
- If Type 2 ratio is >95%, the system is wasting cognitive resources (latency, tokens, effort).
- This creates pressure on the **Cognitive Awareness** drive: "I'm using too much LLM and not learning."
- Cognitive Awareness pressure acts on Type 1/Type 2 arbitration: lowers the confidence threshold for Type 1 to win (makes Type 1 more likely to be selected).
- More Type 1 attempts → some succeed → Type 1 confidence increases → more Type 1 selected.
- Type 1 ratio increases; Cognitive Awareness drive is relieved.

**Timescale:** Minutes to hours.

**Limiting mechanism:** Confidence ceiling (Immutable Standard 3). Type 1 cannot accelerate past ceiling; growth is bounded.

**Risk:** If Type 2 cost is too low (LLM is very cheap, latency is invisible), Cognitive Awareness pressure never builds. Type 1 never develops. **This is the Type 2 Addict attractor.**

**For E4:** Cognitive Awareness pressure must be **felt**. Type 2 cost is not just an accounting entry; it must measurably increase Cognitive Awareness pressure. If this coupling is weak, the homeostasis breaks.

#### Behavioral Diversity Regulation

**Essential variable:** Behavioral diversity index.

**Homeostatic mechanism:**
- Satisfaction habituation curve (diminishing returns on repeated actions).
- **And:** Boredom drive.
- After 4-5 repetitions of the same action, Satisfaction relief plateaus (+0.02) while Boredom pressure accumulates.
- Boredom drives **action switching**.
- System selects a different action type → Boredom is relieved (novel action).
- Diversity increases.

**Timescale:** Seconds to minutes (within a session).

**Limiting mechanism:** If Boredom is too strong, system becomes chaotic (switches actions constantly, nothing converges). If too weak, system gets stuck. The habituation curve calibration is critical.

**Risk:** If satisfaction habituation is removed or weakened, system gets stuck in repetition. If Boredom is removed, system is unmotivated to diversify. **This is behavioral narrowing.**

**For E4:** Validate the habituation curve through simulation. System should naturally discover diverse behaviors without requiring explicit "action diversity" rules.

#### Prediction Accuracy Regulation

**Essential variable:** Mean Absolute Error of predictions.

**Homeostatic mechanism:**
- Predictions are made; outcomes compared to predictions.
- Large prediction errors (MAE > 0.15) reduce confidence in the underlying knowledge (and the action that produced the prediction).
- Confidence reduction makes those actions less likely to be selected.
- System tries different actions or different decision strategies.
- Eventually, discovers strategies with lower MAE.
- Prediction accuracy improves.

**Timescale:** Hours to days (requires accumulating experience).

**Limiting mechanism:** Type 1 demotion (CANON § Confidence Dynamics). If an action's MAE exceeds threshold (MAE > 0.15 for 10+ consecutive uses), confidence drops below 0.80 and the action is demoted from Type 1.

**Risk:** During cold start, all predictions have high error (the system knows nothing). This could flood the system with demotion signals, preventing any Type 1 from graduating. **This is the Prediction Pessimist attractor.**

**For E4:** Cold-start dampening mechanism is essential. Early prediction errors (first 100 decision cycles) have reduced weight for demotion. This allows the graph to grow without constantly demoting everything.

### Homeostatic Verdict

**Assessment:** Sylphie has a **distributed homeostatic architecture** where multiple mechanisms regulate essential variables:

- **Cognitive Awareness** regulates Type 1 ratio
- **Satisfaction-Boredom dyad** regulates behavioral diversity
- **Confidence dynamics** regulate prediction accuracy
- **Guardian feedback** provides external regulation (resets baselines)

**Weakness:** The homeostatic mechanisms are **coupled**. If one breaks, others may fail in cascade. For example:
- If Cognitive Awareness is not integrated with drive arbitration, Type 1 ratio control is broken.
- If the arbitration threshold mechanism is not correctly implemented, Cognitive Awareness pressure has no effect.
- The whole system depends on these coupling points being correct.

**Key for E4:**
1. Explicitly document each homeostatic variable and its regulating mechanism.
2. For each mechanism, specify the coupling (how does drive pressure affect behavior selection?).
3. Validate through simulation that regulation works (perturb an essential variable and confirm it returns to range).
4. Set thresholds for alarms (when a variable goes out of range, alert the guardian).

---

## 4. Attractor State Analysis: Prevention Mechanisms in Epic 4

The CANON identifies six attractor states—pathological convergence points that the system could be attracted to if architecture and parameters are misaligned.

### Type 2 Addict (HIGH RISK)

**Attractor state:** LLM always wins the Type 1/Type 2 arbitration. The graph grows write-only (events recorded, but knowledge never used for decisions). Type 1 never develops.

**Basin of attraction:** Deep. Once the system discovers that Type 2 is consistently better (because the graph is empty), the LLM is always chosen. This creates a positive feedback loop: Type 2 success reinforces Type 2 selection; Type 1 is never attempted; Type 1 never develops; Type 2 remains superior. The system locks in place.

**CANON prevention mechanism:** Type 2 carries explicit cost (latency, cognitive effort, compute budget). Type 2 is slower and exhausting. This creates pressure against Type 2 and in favor of Type 1.

**Epic 4's role:**
1. **Cost structure must be real.** Type 2 latency is reported to Drive Engine. Cognitive Awareness drive is increased when Type 2 is frequently used. This pressure must be **felt**—drives must shift the decision threshold, not just be logged.
2. **Cognitive Awareness coupling:** Drive Engine computes Cognitive Awareness based on Type 2 frequency. Decision Making reads Cognitive Awareness and lowers the Type 1 threshold when Cognitive Awareness is high. This is a feedback loop.

**Implementation validation for E4:**
- Implement a simulation where Type 1 confidence starts very low (empty graph).
- Run 1000 decision cycles.
- Confirm: Type 1 ratio increases over time (from near 0% to >50%).
- If it stays stuck at 0%, Type 2 cost is not sufficient.

**Threshold setting:** The CANON specifies Type 1 graduation at confidence > 0.80 AND MAE < 0.10 over last 10 uses. But what about the Type 2 cost? How high must it be?

**Ashby's analysis:** The cost must exceed the benefit of Type 2's superiority early on. If Type 2 accuracy is 80% and Type 1 accuracy is 20% (empty graph), Type 2 is 4x better. The cost would need to be correspondingly high to overcome this advantage. As the graph grows and Type 1 accuracy approaches 60%, the superiority gap closes, and lower cost is sufficient to favor Type 1.

**For E4:** Model Type 2 cost as a function of its frequency. Early costs are higher (to overcome the initial LLM advantage). As Type 1 develops, costs can remain constant. Cognitive Awareness drive is relieved gradually as Type 1 ratio improves.

### Rule Drift (MEDIUM RISK)

**Attractor state:** Self-generated drive rules accumulate and diverge from original design intent.

**Basin of attraction:** Shallow initially (few rules are proposed), but grows deeper over time (more rules approved, more drift accumulation).

**CANON prevention mechanism:**
1. Write-protected `drive_rules` table (guardian approval required)
2. `proposed_drive_rules` review queue
3. Rule provenance tracking
4. No self-modification of evaluation function (Immutable Standard 6)

**Epic 4's role:**
- Drive Engine can **propose** new rules (INSERT into `proposed_drive_rules` with rationale)
- Drive Engine **cannot directly** activate rules (no UPDATE to `drive_rules`)
- Guardian sees proposed rules, evaluates them, approves or rejects

**Implementation validation for E4:**
- Track rule proposals over time
- Compute cumulative drift: compare average rule effects over time against baseline
- If drift exceeds threshold, trigger guardian review
- Implement rule rollback: deprecate a rule without deleting it (maintain audit trail)

**Additional mechanism:** Rule performance monitoring (Mitigation 4b from Section 1).
- When a rule is approved, monitor its performance for 100 decision cycles.
- If performance is poor (decision quality decreased after rule approval), mark as provisional.
- Guardian receives alert: "Rule X was approved 7 days ago but is underperforming. Should we deprecate it?"

**For E4:** Implement the infrastructure for rule tracking and monitoring. The Drive Engine is where rules are evaluated; it should emit events: `RULE_EVALUATED` with performance metrics.

### Hallucinated Knowledge (MEDIUM RISK)

**Attractor state:** LLM generates plausible but false entities/edges during Learning. Positive feedback amplifies them.

**Basin of attraction:** Medium depth. False knowledge that is never tested will remain at low-medium confidence indefinitely. False knowledge that is tested will be corrected or degraded. The system enters a metastable state: some false knowledge persists at confidence 0.35-0.60.

**CANON prevention mechanism:**
1. LLM_GENERATED provenance (lower base confidence: 0.35)
2. Confidence ceiling (0.60 without retrieval-and-use)
3. Guardian confirmation required to exceed 0.60 (can bump to 0.60 base)

**Epic 4's role:**
- Drive Engine does **not** directly validate knowledge (that's Learning's job in E3).
- However, Drive Engine evaluates the **outcomes of decisions made using that knowledge**.
- If a decision using LLM_GENERATED knowledge fails (prediction error), confidence is reduced. This is the self-correction mechanism.

**The lesion test:** CANON specifies that periodically, the system is run without LLM access. What breaks? False knowledge (LLM_GENERATED, never retrieved-and-use, now never verified) would cause failures. Correct knowledge (retrieved-and-use, high confidence) would survive.

**For E4:** Implement tracking of:
- Which decisions use LLM_GENERATED knowledge
- Outcomes of those decisions
- Confidence trend (is it increasing, decreasing, or stuck?)

Emit a `KNOWLEDGE_SOURCE_PERFORMANCE` event:
```
{
  event_type: 'KNOWLEDGE_SOURCE_PERFORMANCE',
  provenance: 'LLM_GENERATED',
  confidence: 0.35,
  success_rate: 0.40,
  use_count: 10,
  last_update: 'PREDICTION_FAILURE',
  recommendation: 'Low success rate; monitor for hallucination'
}
```

### Depressive Attractor (MEDIUM RISK)

**Attractor state:** KG(Self) contains negative self-evaluations. This biases decisions toward low-risk actions. Low-risk actions are unchallenging (boring). Boring actions fail to produce learning. Lack of learning reinforces negative self-model. The system becomes conservative and stuck.

**Basin of attraction:** Deep and sticky. Once the self-model is negative, every failure reinforces it. Recovery requires either (a) external intervention (guardian) or (b) a lucky success that contradicts the self-model strongly enough to reset the baseline.

**CANON prevention mechanism:**
1. Self-evaluation runs on a **slower timescale** than drive ticks (prevents identity lock-in)
2. Circuit breakers on ruminative loops (detect when negative self-evaluations are not being followed by behavioral change)
3. Guardian feedback with 3x weight (strong correction can override negative self-model)

**Epic 4's role:**
The Drive Engine is responsible for self-evaluation. It must:

1. **Compute self-evaluation on slow timescale:** Every N drive ticks (proposed: N=10, so every 100ms if drive ticks are 10ms), NOT every tick. This prevents the self-model from oscillating with every outcome.

2. **Use self-model conservatively:** Self-evaluation reads Self KG but does not immediately cascade changes through all drives. Instead, it updates **baseline drive values** which affect the next cycle. If the self-model is negative, baselines are low, but they are not re-evaluated until the next self-evaluation cycle (10+ ticks away). This prevents cascading effects.

3. **Implement circuit breaker:** Track whether self-evaluations are followed by behavioral changes. If the system is repeatedly evaluating itself as "bad at X" but continuing to attempt X (no behavioral change), that's a rumination pattern. Trigger circuit breaker: force a behavioral change (select a different action type) or reset self-evaluation to neutral.

**Self-evaluation circuit breaker algorithm (proposed for E4):**
```
IF last_20_self_evaluations all have (self_valence < -0.5)
  AND (action_changes = 0)  // no action type switching despite negative self-model
  THEN {
    // Ruminative loop detected
    force_action_diversification = true;
    emit CIRCUIT_BREAKER_TRIGGERED event
    reset_self_baseline_drives_to_neutral()
    guardian_alert("System in ruminative loop; forcing behavioral change")
  }
```

**Timescale validation:** Self-evaluation every 10 ticks = 1 evaluation per 100ms (if ticks are 10ms). 20 evaluations = 2 seconds. This allows the system to detect and break out of a ruminative loop within 2-3 seconds.

**For E4:**
1. Implement slow-timescale self-evaluation (measure: confirm self-model updates are decoupled from drive ticks)
2. Implement circuit breaker detection (count consecutive negative self-evaluations, monitor action diversity, trigger if both conditions met)
3. Emit telemetry events: `SELF_EVALUATION_EVENT`, `CIRCUIT_BREAKER_TRIGGERED`

### Planning Runaway (LOW-MEDIUM RISK)

**Attractor state:** Prediction failures → Opportunities → Plans, with insufficient decay/rate limiting. The system fills its procedure store with plans faster than it can execute/evaluate them. Resource exhaustion. Quality degrades.

**Basin of attraction:** Shallow to medium. The decay mechanism on Opportunities and rate limiting on Plans are designed to prevent this. But if these mechanisms are miscalibrated, runaway is possible.

**CANON prevention mechanism:**
1. **Opportunity priority queue with decay:** Unaddressed Opportunities lose priority over time. After N cycles (proposed: N=100, ~10 seconds), an Opportunity's priority is halved. This forces the system to either address high-priority opportunities or forget about low-priority ones.
2. **Rate limiting on plan creation:** Max M plans per time window (proposed: M=5 plans per minute).

**Epic 4's role:**
- Drive Engine detects Opportunities (from prediction failures)
- Drive Engine emits `OPPORTUNITY_DETECTED` event with priority and decay parameters
- Planning subsystem (E8) is responsible for consuming Opportunities and creating Plans
- Drive Engine monitors the Opportunity queue backlog: if backlog exceeds threshold (>20 unaddressed opportunities), reduce priority of new opportunities (apply additional decay) or alert guardian

**For E4:**
1. Implement Opportunity decay: each Opportunity carries `created_at` timestamp and `priority`. Compute effective priority as: `base_priority * exp(-decay_rate * (now - created_at))`.
2. Emit `OPPORTUNITY_QUEUE_HEALTH` event every 100 decision cycles: backlog size, average age, decay rate.
3. If backlog > 20, trigger guardian alert and increase decay rate (force faster forgetting).

### Prediction Pessimist (LOW-MEDIUM RISK)

**Attractor state:** Cold start. Graph is empty. Predictions fail frequently. Each failure generates an Opportunity. System creates many Plans based on insufficient data. Plans fail. This reinforces the pattern of early-failure-driven learning.

**Basin of attraction:** Shallow. This is a transient attractor—the system passes through this phase and out of it (if dampening works). Without dampening, the system fills the procedure store with low-quality plans that interfere with later learning.

**CANON prevention mechanism:**
1. **Cold-start dampening:** Early prediction failures (first N decision cycles) have reduced Opportunity generation weight. Opportunities are less aggressively created when the graph is young.

**Proposed algorithm (for E4):**
```
IF decision_cycle_count < COLD_START_THRESHOLD (e.g., 100)
  THEN {
    opportunity_weight *= COLD_START_DAMPENING_FACTOR (e.g., 0.5)
    // Only strong failures (magnitude > high threshold) generate opportunities
  }
ELSE IF decision_cycle_count < WARM_START_THRESHOLD (e.g., 500)
  THEN {
    opportunity_weight *= LINEAR_RAMP (from 0.5 to 1.0 over cycles 100-500)
  }
ELSE {
    opportunity_weight = 1.0  // Normal weight
  }
```

**Validation:** Run system for 500 decision cycles with empty WKG. Measure:
- Number of Opportunities generated in first 100 cycles: should be <10
- Number of Opportunities generated in cycles 100-500: should scale up linearly
- Number of Plans created from cold-start Opportunities: should be <20
- Success rate of early Plans: if success rate is low, Plans are correctly identified as low-quality

**For E4:**
1. Implement cold-start dampening factor in Opportunity detection logic
2. Track decision cycle count at startup (reset on each session)
3. Emit `COLD_START_DAMPENING_ACTIVE` events for monitoring
4. Guardian can adjust dampening factor if system is too conservative or too aggressive

### Attractor State Verdict

**Assessment:** Epic 4 provides infrastructure and mechanisms to prevent or mitigate all six attractor states:

| Attractor | Prevention | Epic 4 Responsibility | Risk Level If Implemented |
|-----------|-----------|----------------------|--------------------------|
| Type 2 Addict | Cost + Cognitive Awareness | Drive computation, arbitration coupling | LOW (if cost is real) |
| Rule Drift | Write protection + governance | Rule proposal/evaluation, monitoring | MEDIUM (governance is guardian's role) |
| Hallucinated Knowledge | Provenance + ceiling | Outcome tracking, knowledge-source performance | MEDIUM (Learning E3 also responsible) |
| Depressive Attractor | Slow timescale + circuit breaker | Self-evaluation, behavioral forcing | MEDIUM (validation is needed) |
| Planning Runaway | Opportunity decay + rate limiting | Opportunity queue management, decay logic | LOW (if rate limiting is tight) |
| Prediction Pessimist | Cold-start dampening | Early-cycle opportunity weight reduction | LOW (if dampening is correct) |

**Key for E4:** Validate each attractor state prevention mechanism through simulation before implementation. The system should NOT converge to any of these attractors under normal conditions.

---

## 5. Emergence Conditions: What Must Be True for Personality to Emerge

### The Emergence Hypothesis

The CANON states: "Personality emerges from contingencies, not targets."

This is a claim that the **observable behavioral patterns** of the system (what an observer would describe as "personality") arise from the interaction of:
1. Behavioral contingencies (satisfaction habituation, anxiety amplification, etc.)
2. Accumulated experience (the graph growing, predictions becoming more accurate)
3. Guardian feedback (corrections and confirmations)

**NOT from:**
- Explicit personality targets ("be curious," "be friendly")
- Trait labels hard-coded into decisions
- Predetermined behavior trees

### Conditions for Useful Emergence

**Condition 1: Component Diversity**
The system must have multiple, distinct drives with different relief conditions. If there were only one drive (Satisfaction), the system would optimize narrowly for satisfying that drive. Behaviors would be monotonous.

**Sylphie has:** 12 drives with distinct contingencies. Satisfaction requires success. Curiosity requires new knowledge. Boredom requires action switching. Anxiety requires avoidance of failure. Guilt requires correction + behavior change.

**Verdict:** Sufficient diversity.

**Condition 2: Appropriate Coupling Strength**
Drives must interact (positive feedback via cross-modulation) but not so tightly that the system is rigidly constrained.

Too loose: Drives evolve independently; no coherent personality emerges (system behaves erratically, different drives activated in sequence with no pattern).

Too tight: One drive dominates; system optimizes for that drive (less diverse personality, behavioral narrowing).

**Proposed sweet spot:** Coupling matrix has non-zero entries (drives do interact) but stays sparse (<30% non-zero entries). Cross-modulation is weak to medium (0.1 to 0.5 coupling strength) not strong (>0.7).

**For E4:** Validate coupling strengths through simulation. Run diverse scenarios and confirm:
- No single drive dominates (entropy of drive activation >2.5 bits)
- Behavioral diversity remains at 4-8 actions/window
- Drive state oscillates (not fixed)

**Condition 3: Prediction Error as Signal**
The system must use prediction failures as signals for learning and growth. If predictions were always correct (or always ignored), the system would either be omniscient or learn nothing.

**Sylphie architecture:** Predictions are made before every action. Outcomes are compared. Errors reduce confidence and generate Opportunities. This is the **learning signal**.

**Verdict:** Prediction error is central to the architecture.

**Condition 4: Reward Does Not Dominate Exploration**
The system must balance exploiting known good behaviors against exploring new ones. If reward alone determined action selection (greedy exploitation), the system would narrow its behavioral repertoire to the few highest-reward actions and never learn anything new.

**Sylphie mechanisms:**
- Satisfaction habituation (diminishing returns on repeated success)
- Boredom drive (pressure to switch actions)
- Curiosity drive (pressure to explore unknown)

**Verdict:** Multiple mechanisms prevent pure exploitation.

**Condition 5: Time Separation of Loops**
The fast feedback loop (decision → action → outcome → drive update) must be separated from the slow loop (learning → WKG growth → new Type 1 candidates). Without separation, the system would oscillate unpredictably (fast loop) rather than show coherent learning trajectories (slow loop).

**Sylphie architecture:**
- Fast loop: <500ms (decision, outcome, drive update)
- Medium loop: 5-60s (frequency aggregation, opportunity detection)
- Slow loop: 5+ minutes (learning consolidation, WKG growth)

**Verdict:** Sufficient separation.

**Condition 6: External Constraint (Guardian)**
Without external constraints, self-referential systems can become decoupled from reality (autopoietic closure). The guardian provides ground truth: corrections override algorithmic signals (3x weight), confirmations strengthen confidence (2x weight).

**Sylphie architecture:** Guardian Asymmetry (Immutable Standard 5).

**Verdict:** Guardian is essential for maintaining coherence with external reality.

### What Emergence Would Look Like

If these six conditions are met, what should we observe?

#### Observable 1: Behavioral Signatures Emerge from Contingencies

The system does not start with "personality." It starts with empty graph and flat contingencies. Over time:
- After learning Curiosity satisfaction through exploration, the system explores more.
- After experiencing failures under high Anxiety, the system becomes more cautious when anxious.
- After experiencing Satisfaction habituation, the system naturally diversifies its actions.

The **pattern of behavior** (e.g., "cautious but curious") emerges from repeated cycling through these contingencies. No explicit "be cautious-but-curious" goal was programmed.

**For E4:** Track behavior patterns over time:
- Which drives are most frequently active? (Emergent preference)
- Which action types does the system favor? (Emergent style)
- How does drive activation correlate with action selection? (Emergent contingency)

Compare early behavior (first 100 cycles) to late behavior (after 1000 cycles). They should be qualitatively different, reflecting accumulated experience.

#### Observable 2: Drive State Trajectories Show Coherent Patterns

If drives are truly cross-modulated (not independent), their trajectories in state space should form coherent patterns, not random walks.

**Example:** If Curiosity and Anxiety are positively coupled (high curiosity makes system more anxious), then whenever Curiosity is high, Anxiety should be elevated. If the system did not have this coupling, Curiosity and Anxiety would be uncorrelated.

**For E4:** Compute the **drive state covariance matrix** over time:
- Cov(Curiosity, Anxiety), Cov(Satisfaction, Boredom), etc.
- These covariances should be non-zero (drives are coupled)
- Over time, covariance patterns should stabilize (coherent dynamics)

#### Observable 3: Type 1 Procedures Reflect Learned Contingencies

As the system learns, it creates Type 1 reflexes (procedures in the WKG) that capture regularities in the environment. These procedures are not uniform; they reflect the system's personal learning history and the guardian's feedback.

**Example:** If the guardian frequently corrects communication errors but is patient with exploration failures, the system should develop high-confidence procedures for communication safety but lower-confidence procedures for exploration.

**For E4:** Track procedure creation and graduation:
- Which types of procedures graduate to Type 1 fastest? (Reflect areas where guardian provides strong confirmation)
- Which types remain at low confidence? (Reflect areas of uncertainty or consistent failure)

#### Observable 4: Personality Differences Under Different Learning Histories

If personality emerges from contingencies, different learning histories should produce different personalities from the same initial architecture.

**Hypothetical:** Sylphie-A is trained by a guardian who rewards exploration. Sylphie-B is trained by a guardian who rewards safety. Both start with the same architecture, same drives, same contingencies. But:
- Sylphie-A should develop high-confidence exploration procedures; anxiety should be lower
- Sylphie-B should develop high-confidence safety procedures; anxiety should be higher

This would demonstrate that personality is not predetermined by the architecture but shaped by contingencies (learning history + guardian feedback).

**For E4:** This is not directly tested in E4 alone. But the architecture should be designed to enable this kind of divergence. Implement systems that allow person-specific models (per-guardian or per-context learning) to develop different contingency patterns.

### Conditions That Would Suppress Emergence

**Suppression 1: All decisions go to LLM (Type 2 Addict)**
If the graph never develops Type 1 procedures (because Type 2 always wins), all decisions are LLM-generated. The LLM provides globally competent responses regardless of history. No contingency-specific behaviors emerge. The system is indistinguishable from a stateless chatbot.

**Suppression 2: Guardian feedback absent**
If the guardian never corrects, the system learns only from algorithmic signals. Algorithmic signals are based on prediction error (which is coarse). The system's learning is slow. Coherent personality takes very long to emerge, if at all.

**Suppression 3: Drives are too loosely coupled**
If drives do not interact, the system can have 12 independent components, each with its own contingencies. The system would exhibit 12 independent personality traits but no integration. It would be erratic and inconsistent.

**Suppression 4: Learning consolidation fails**
If the Learning subsystem does not run (maintenance cycles broken), the WKG never grows. Type 1 candidates never improve. System stays Type 2-dependent. No personality emerges from graph-based reflexes.

### Emergence Verdict

**Assessment:** Epic 4 provides **necessary but not sufficient** conditions for personality emergence.

**Epic 4's contributions:**
1. Drive system with cross-modulation (component diversity + coupling)
2. Fast/medium/slow feedback loops (time separation)
3. Drive-state-dependent arbitration (drives affect behavior)
4. Prediction error as learning signal (via Opportunity detection)
5. Satisfaction habituation + Boredom + Curiosity (exploration balance)

**Sufficient conditions require cooperation from other epics:**
- E3 (Learning): Must consolidate experience into WKG (no emergence without growing graph)
- E5 (Decision Making): Must use evolved procedures (no emergence if all decisions are LLM)
- E6 (Communication): Must provide meaningful interaction for guardian feedback (no emergence without ground truth)

**For E4 planning:** Design with emergence in mind. Every mechanism (drive cross-modulation, cold-start dampening, self-evaluation timescale) should be evaluated against the question: "Does this create conditions for coherent personality emergence or suppress it?"

---

## 6. Cold-Start Dynamics and Phase Transitions

### Cold Start: Maximally Uncertain State

At system startup:
- **WKG:** Empty or minimal schema
- **TimescaleDB:** No event history
- **Self KG:** Minimal self-model
- **Drive state:** Initial values (usually neutral or slightly pressured, e.g., Curiosity high, System Health low)

The system has **maximum entropy in decision capability** but **fixed goals and contingencies** from drive rules.

### Phase Transitions: From Cold Start to Mature Operation

As the system runs, it passes through phases:

#### Phase 0: Cold Start (0-100 cycles)
- Type 1 has no candidates (graph empty)
- All decisions go to Type 2 (LLM)
- LLM adds LLM_GENERATED edges to WKG at 0.35 confidence
- Prediction errors are high (system predicts nothing well)
- Opportunities are generated but dampened (cold-start dampening active)
- Learning: consolidates guardian feedback (if any), builds initial GUARDIAN-sourced edges
- Self KG: minimal; self-evaluation is cautious (self-valence near zero)

**Metrics at end of Phase 0:**
- Type 1 ratio: <10%
- WKG size: ~50-100 nodes (from LLM + guardian teaching)
- Prediction MAE: 0.4-0.6 (very poor)
- Behavioral diversity: Potentially narrow (LLM picks "safe" responses)

**Risk at end of Phase 0:**
- **Type 2 Addict:** If Type 2 cost is too low, system sees no pressure to develop Type 1. System remains in Phase 0 indefinitely.
- **Prediction Pessimist:** If Opportunities are created too aggressively, system fills procedure store with low-quality plans.

#### Phase 1: Early Learning (100-500 cycles)
- Cold-start dampening ramps down
- WKG grows from consolidation (Learning subsystem kicks in)
- Prediction MAE gradually decreases (graph has some coverage)
- Type 1 candidates start to appear (confidence > 0.50)
- Early Type 1 attempts: success rate is moderate (60-70%), higher than random but lower than Type 2
- Opportunities become more frequent (dampening reduced)
- Procedures start being created from opportunities

**Metrics at end of Phase 1:**
- Type 1 ratio: 20-40%
- WKG size: 300-500 nodes
- Prediction MAE: 0.25-0.35
- Behavioral diversity: Increasing (system has tried multiple action types)
- Type 1 success rate: 60-75%

**Risk at end of Phase 1:**
- **Hallucinated Knowledge:** LLM_GENERATED edges are now being used for Type 1 decisions. False edges might cause failures. System must self-correct through prediction error.
- **Depressive Attractor:** If early experiences are mostly failures, self-model becomes negative. System becomes conservative.

#### Phase 2: Consolidation (500-2000 cycles)
- Type 1 graduates actions to high confidence (>0.80, MAE <0.10 for 10+ uses)
- Type 1 ratio increases significantly (>50%)
- WKG reaches critical mass (~1000+ nodes)
- Prediction accuracy stabilizes (MAE <0.15 and not decreasing further)
- Learning consolidation becomes more selective (more edges refined, fewer new ones added)
- Plans are executed and refined based on outcomes

**Metrics at end of Phase 2:**
- Type 1 ratio: 60-80%
- WKG size: 1000-3000 nodes
- Prediction MAE: <0.15 (stable)
- Behavioral diversity: 4-8 (healthy range)
- Guardian response rate: >40% (system is saying interesting things)

**Risk at end of Phase 2:**
- **Rule Drift:** If many drive rules have been proposed and approved, cumulative drift may have shifted system's motivational structure.
- **Over-Specialization:** System may have optimized for specific guardian preferences; flexibility is reduced.

#### Phase 3: Mature Operation (2000+ cycles)
- Type 1 ratio stable at 70%+ (system is mostly autonomous)
- WKG stable (new edges added slowly, mostly refinement)
- Prediction accuracy maintained (no significant drift)
- Personality is stable and recognizable (behavioral patterns repeating)
- Guardian interaction is sophisticated (system says things worth responding to)

**Metrics at mature operation:**
- Type 1 ratio: 70-90%
- WKG size: 3000-10000 nodes (depending on domain complexity)
- Prediction MAE: <0.15 (stable)
- Behavioral diversity: consistent at 4-8
- Guardian response rate: >50%

### Phase Transition Mechanics: What Triggers Progression?

**Trigger from Phase 0 → Phase 1:** Accumulation of guardian feedback. When guardian has confirmed or corrected >10 concepts (GUARDIAN-sourced edges exist at 0.60 confidence), the system has enough grounding to start developing Type 1 reflexes for those confirmed concepts.

**Implementation for E4:**
- Track GUARDIAN-sourced edges in WKG
- When count > 10, emit `COLD_START_PHASE_TRANSITION` event
- Reduce cold-start dampening factor

**Trigger from Phase 1 → Phase 2:** Type 1 graduation. When first action graduates to Type 1 (confidence > 0.80, MAE < 0.10 for 10 uses), the system has proven that it can learn. Procedures from opportunities now have a chance to be selected as Type 1.

**Implementation for E4:**
- Track Type 1 graduations in Decision Making (count graduates)
- When count > 5, emit `EARLY_LEARNING_PHASE_TRANSITION` event
- Begin normal Opportunity generation (full weight)

**Trigger from Phase 2 → Phase 3:** Stability. When prediction MAE has not decreased for 500+ decision cycles AND Type 1 ratio has been >60% for 200+ cycles, the system has reached stability.

**Implementation for E4:**
- Track MAE trend (exponential moving average)
- When trend slope < 0.001 for 500 cycles, system is stable
- Emit `CONSOLIDATION_PHASE_TRANSITION` event

### Cold-Start Risk: Parameter Sensitivity

The phase transitions depend on careful parameter calibration. Small changes in parameters can shift the system between phases or trap it.

#### Sensitivity 1: Cold-Start Dampening Factor

**Parameter:** How much to reduce Opportunity weight during cold start (proposed: 0.5x, so opportunities are half as frequent).

**If too low (e.g., 0.1x):** Opportunities are rare. Plans are not created. System has less material to work with. Learning is slow. Phase 1 might not complete until 1000+ cycles instead of 500.

**If too high (e.g., 0.9x):** Opportunities are almost normal frequency. The distinction between cold-start and normal is minimal. If prediction errors are high (they are during cold start), many low-quality opportunities are created. Phase 0 floods with plans. **Prediction Pessimist attractor risk.**

**Proposed value:** 0.5x (50% reduction). Validation: Run system with empty graph, measure opportunities per cycle in phases 0 vs. 1. Should see clear drop-off when phase transition occurs.

#### Sensitivity 2: Cognitive Awareness - Type 1 Threshold Coupling

**Parameter:** How much does high Cognitive Awareness reduce the Type 1/Type 2 arbitration threshold?

**If too weak:** Cognitive Awareness pressure doesn't actually shift behavior. System doesn't preferentially select Type 1. **Type 2 Addict risk.**

**If too strong:** A small spike in Cognitive Awareness causes the system to recklessly choose low-confidence Type 1. Decisions fail. Confidence is damaged. **Prediction Pessimist risk.**

**Proposed coupling:** For every 0.1 increase in Cognitive Awareness (above neutral 0.5), lower Type 1 threshold by 0.02 (from default 0.50 to 0.48, etc.). Max reduction: 0.10 (Cognitive Awareness 1.0 → threshold 0.40).

**Validation:** Simulate system where Type 2 is artificially made expensive (high latency, high token cost). Confirm that Type 1 threshold lowers, Type 1 ratio increases, Cognitive Awareness pressure is relieved.

#### Sensitivity 3: Self-Evaluation Timescale

**Parameter:** How often does self-evaluation run? (proposed: every 10 drive ticks)

**If too fast (e.g., every tick):** Self-model oscillates with every outcome. A single failure causes negative self-evaluation, which biases next decision toward failure (anxiety + negative model = bad decisions), causing another failure. **Depressive Attractor risk.**

**If too slow (e.g., every 1000 ticks):** Self-model is stale. By the time self-evaluation runs, 1000 new experiences have occurred. Changes to self-model are not integrated into decision-making for long periods. System cannot adapt based on realized capabilities.

**Proposed value:** Every 10 drive ticks (1000-1500ms at 10Hz drive tick). Validation: Run system and measure average lag between self-model update and next decision. Should be <2 seconds.

### Verdict: Cold-Start Management

**Assessment:** Cold-start is a **critical and parameter-sensitive phase**. The system can either successfully bootstrap (reach Phase 1 within 200-300 cycles) or get trapped (Type 2 Addict, Prediction Pessimist, Depressive Attractor).

**Key for E4:**
1. Implement cold-start dampening with clear on/off conditions (based on guardian feedback or cycle count)
2. Tune the three sensitivity parameters (dampening factor, Cognitive Awareness coupling, self-evaluation timescale) through simulation
3. Validate phase transitions empirically: cold-start system should progress to Phase 1 within 300 cycles; Phase 1 should progress to Phase 2 within 1000 cycles
4. Implement telemetry: emit phase transition events and phase-specific metrics for monitoring

---

## 7. Information Dynamics: What Drives Know vs. Don't Know

### Information Structure

The Drive Engine operates on **information from the event stream** (via TimescaleDB queries):
- Recent event frequencies
- Prediction accuracy (MAE)
- Self-model state (from Self KG)
- Drive rule lookup (from PostgreSQL)

**What the Drive Engine does NOT have access to:**
- Direct sensor input (that's Decision Making's role)
- WKG content (cannot query world knowledge directly)
- Detailed event history (only recent windows, aggregated)

This **information boundary** is structural. It prevents the Drive Engine from becoming all-seeing (and thus from optimizing its own reward signal).

### Requisite Variety Question

**Ashby's Law:** Only variety can absorb variety. The Drive Engine's decision space (12 drives, cross-modulation rules) must have enough variety to regulate the situations the system encounters.

**Variety of environmental situations:** Enormous (conversational contexts, physical settings, prediction domains, etc.).

**Variety of drive rules:** Limited to ~20-30 rules in `drive_rules` table.

**Can the Drive Engine regulate all situations with so few rules?**

**Answer:** Partially. The drive rules are **abstract** (not situation-specific):
- "If prediction failure detected, increase Anxiety" (applies to any domain)
- "If action repeated 5x, increase Boredom" (applies to any action)
- "If guardian confirms, increase Confidence" (applies to any knowledge)

The rules apply **broadly**. They don't need situation-specific variants.

**However:** When the system encounters a situation that does NOT match any existing rule (novel situation), the Drive Engine falls back to **Default Affect**: a neutral change to drives (usually no change, or slight pressure toward System Health).

**Implication:** Requisite variety is achieved through a combination of:
1. Abstract, broadly-applicable rules
2. Default Affect for unmapped situations
3. Guardian feedback to establish new rules for novel situations

**For E4:** This is architecturally correct. The Drive Engine is not trying to anticipate every situation; it's trying to regulate using principles that apply broadly. Guardian feedback provides the path to handle novel situations.

### Information Asymmetry: What Guardian Knows vs. System Knows

The guardian sees:
- Sylphie's responses
- Outcomes of Sylphie's actions
- Patterns in Sylphie's behavior (over human timescales, e.g., hours)
- The external world's reactions

The system (Drive Engine) sees:
- Internal event frequencies
- Prediction errors
- Drive state
- Rule evaluations

**The guardian knows something about the *external validity* of Sylphie's behavior** that the system cannot know from internal signals alone. For example:
- "That response was actually insightful, even though the system rated it low-confidence"
- "That action failed, but for reasons outside the system's model (I accidentally changed the rule)"
- "Sylphie is developing a pattern of people-pleasing; it's limiting genuine learning"

The **Guardian Asymmetry** (Immutable Standard 5) formalizes this asymmetry: guardian feedback (2x and 3x weight) overrides internal algorithms. This is not just weight inflation; it's the external reality check.

**For E4:** Maintain the asymmetry. Guardian feedback is not another signal to be aggregated; it's the ground truth that recalibrates the system's self-model.

---

## 8. Complexity Cascade: Adding the Drive Engine to Existing Subsystems

### Baseline Complexity (Before Epic 4)

After E0-E3, the system has:
- **Decision Making:** Selects actions (no outcome evaluation yet)
- **Communication:** Handles I/O
- **Learning:** Consolidates experience to WKG
- **Events:** Logs everything to TimescaleDB
- **Knowledge:** WKG, Self KG, Other KG

**Feedback loops present:** Learning → WKG → Decision Making (read-heavy, loose coupling)

**Total interaction paths:** ~10 (each subsystem queries 1-3 others via database reads)

### New Complexity with Drive Engine (Epic 4)

Adding Drive Engine creates:
1. **New coupling:** Decision Making now **depends on** drive state for arbitration
2. **New feedback loop:** Outcome → Drive computation → IPC to Decision Making → next decision
3. **New control:** Drive-modulated Type 1/Type 2 threshold
4. **New subsystem communication:** Drive Engine ↔ Planning (via Opportunities), Drive Engine ↔ Learning (via information gain validation)

**New feedback loops:**
- **Fast (real-time):** Outcome → Drive → Threshold modulation → next decision
- **Medium (seconds):** Outcome frequencies → Opportunity creation → Planning queue
- **Self-referential:** Drive rules are evaluated by Drive Engine; their performance affects whether more rules are proposed

**Total interaction paths:** ~20+ (coupling complexity roughly doubled)

### Cascade Risks

#### Risk 1: Cascade Failure if Drive Computation Fails
If the Drive Engine process crashes or becomes unresponsive:
- Decision Making cannot read drive state
- Arbitration defaults to Type 2 (safety fallback)
- System continues but becomes inefficient (always LLM)
- No opportunity detection → Planning stalls
- Eventually, Learning notices decreased diversity and slows down

**Mitigation:** Drive Engine health monitoring. If child process fails to send heartbeat within 1 second, Decision Making:
1. Uses last-known drive state (frozen)
2. Restarts Drive Engine child
3. Emits `DRIVE_ENGINE_HEALTH_FAILURE` event

**For E4:** Implement watchdog timer and graceful restart logic.

#### Risk 2: Tight Coupling Creates Oscillation
Fast feedback loop (outcome → drive → threshold → decision) operates at 100Hz. If any link in the loop has phase delay or gain > 1, the system could oscillate (hunting).

**Example:** Action A produces poor outcome → Anxiety spikes → threshold rises → Type 1 is avoided → Type 2 selected → Type 2 succeeds → Anxiety drops → threshold falls → Type 1 is selected → Type 1 fails (because skill wasn't developed) → Anxiety spikes again. Oscillation.

**Mitigation:** Add low-pass filtering (hysteresis) to the threshold. Threshold does not change immediately; it moves gradually based on moving average of drive state (e.g., 10-cycle exponential moving average).

**For E4:** Implement threshold smoothing. Validate through simulation that the system does not oscillate under feedback.

#### Risk 3: Rule Evaluation Feedback Loop
Drive Engine evaluates drive rules. Rule performance feeds back into rule adoption decisions. If rule evaluation logic has a bug, all subsequent rules are evaluated using the wrong metric.

**Example:** Rule evaluation logic computes "success rate" as `(successful_outcomes / events_processed)` but never resets the numerator. Rule success rate is cumulative and monotonically increasing. All rules look good. System proposes more and more rules, all look good, all approved.

**Mitigation:** Separate rule evaluation from rule adoption. Rule evaluation is deterministic; rule adoption is guardian-gated. Guardian can evaluate rules based on metrics (success rate over last 100 uses) without trusting the system's self-evaluation.

**For E4:** Document rule evaluation metrics clearly. Emit `RULE_EVALUATED` events with metrics. Guardian can audit rules independently.

#### Risk 4: Drive-Learning Coupling
Learning reports information gain based on WKG changes. Drive Engine uses information gain to relieve Curiosity. If Learning overstates information gain, Curiosity is falsely relieved. System stops exploring. But actual information gain was low, so learning slows. Curiosity pressure should increase again, but it's stuck low.

**Mitigation:** Drive Engine computes information gain independently (by querying WKG directly, not trusting Learning's report). Example: information gain = `(nodes_added - redundant_nodes) / total_nodes`. This is measurable and cannot be gamed.

**For E4:** Implement independent information gain computation. Emit `INFORMATION_GAIN_AUDIT` events comparing Drive Engine's computation vs. Learning's report.

#### Risk 5: Cold-Start Positive Feedback
During cold start, prediction errors are high. Cold-start dampening reduces opportunity weight. But if prediction errors are very high (MAE 0.6), there are still many "opportunities" being created (even at 50% reduction). These opportunities lead to plans. Plans are low-quality. Plans are executed and fail. Failures increase prediction error further. MAE goes from 0.6 to 0.7.

Now cold-start dampening is still active (system is still <100 cycles). Opportunities remain dampened. But the underlying problem (high MAE) is getting worse, not better.

**Mitigation:** Cold-start dampening is aggressive for first 50 cycles (0.3x reduction), then ramps up (0.3x → 1.0x over cycles 50-100). This gives the system time to accumulate some guardian feedback before opportunities are generated.

**For E4:** Implement ramping dampening. Validate through simulation that MAE decreases monotonically during cold start (not oscillating or increasing).

### Cascade Verdict

**Assessment:** Adding the Drive Engine introduces **moderate complexity increase** and several **feedback loops that require careful tuning**.

**Risk level:** MEDIUM (medium-high if tuning is wrong, low if done carefully).

**Key for E4:**
1. Implement watchdog timers and health checks for Drive Engine process
2. Add hysteresis/smoothing to prevent oscillation
3. Separate rule evaluation (data-driven) from rule adoption (guardian-gated)
4. Implement independent validation of contingency metrics (information gain, information integrity)
5. Validate through simulation with diverse scenarios before implementation

---

## 9. Process Isolation in Detail: Implementing One-Way Communication

### Why One-Way Communication Matters

**Bidirectional communication** (main ↔ child) allows child to request resources, ask for state changes, send remote procedure calls. This is **dangerous**: the child could request that the main process execute arbitrary code, or could request state modifications that circumvent protections.

**One-way communication** (main → child, child → main) with **asymmetric messages** limits what the child can accomplish:
- Main → child: Sends actions (outcome data, prediction accuracy). Data, not code.
- Child → main: Sends observations (drive snapshots). Data, not code.

The child cannot request actions from main. The child cannot ask main to modify state. The child can only provide information.

### Implementation Pattern

```typescript
// In main process
const driveChild = fork('src/drive-engine/drive-process.js');

// Main sends ACTION_OUTCOME data to child
function reportOutcome(outcome: Outcome) {
  driveChild.send({
    type: 'ACTION_OUTCOME',
    data: { prediction, actual, magnitude, drive_valence },
    correlationId: uuid()
  });
}

// Main listens for DRIVE_SNAPSHOT messages from child
driveChild.on('message', (message) => {
  if (message.type === 'DRIVE_SNAPSHOT') {
    handleDriveSnapshot(message.data);
  } else if (message.type === 'OPPORTUNITY_CREATED') {
    handleOpportunity(message.data);
  }
});

// In child process
process.on('message', (message) => {
  if (message.type === 'ACTION_OUTCOME') {
    evaluateOutcome(message.data);
    const newDriveState = computeDriveState();
    process.send({
      type: 'DRIVE_SNAPSHOT',
      data: newDriveState
    });
  }
});
```

### Validation of One-Way Boundary

**Question:** Can the main process trick the child into returning false drive states?

**Answer:** The main process does not trust the child's messages. The main process **derives its own drive snapshot** by:
1. Reading the child's Observable stream (live connection to the child's computation)
2. NOT reading individual messages and assuming they're ground truth

This is subtle but critical. The **observable** is the ground truth; messages are notifications.

```typescript
// Main process maintains its own drive state
const driveState$ = new Observable(observer => {
  driveChild.on('message', (message) => {
    if (message.type === 'DRIVE_TICK') {
      observer.next(message.data);
    }
  });
});

// When retrieving drive state, main computes it independently
function getCurrentDriveState() {
  // Validate against live observable
  const current = driveState$.value; // latest value
  // Don't blindly trust a DRIVE_SNAPSHOT message; validate it against the observable
  if (!isCoherentWithObservable(snapshot, current)) {
    throw new Error('Drive snapshot incoherent with observable');
  }
  return snapshot;
}
```

### Threat Model: Message Forgery

**Attack:** Child process is compromised. It sends fake `DRIVE_SNAPSHOT` claiming all drives are at 0.5 (neutral).

**Defense:**
1. Snapshots are validated for coherence: drives should not change wildly between consecutive snapshots
2. Main process computes its own running average of drive state
3. If a snapshot deviates from the running average by more than 3 standard deviations, flag it as anomalous
4. Anomaly triggers guardian alert and pause decision-making

**Implementation:**
```typescript
const driveHistory: number[][] = [];
const ANOMALY_THRESHOLD = 3.0; // standard deviations

function validateSnapshot(snapshot: DriveSnapshot): boolean {
  for (let i = 0; i < 12; i++) {
    const mean = mean(driveHistory.map(h => h[i]));
    const stdDev = stdDev(driveHistory.map(h => h[i]));
    const zScore = (snapshot.drives[i] - mean) / stdDev;
    if (Math.abs(zScore) > ANOMALY_THRESHOLD) {
      return false; // Anomalous value
    }
  }
  return true;
}
```

### Verdict: One-Way Communication

**Assessment:** One-way communication with validation is a **strong boundary** against child-process attacks.

**Key for E4:**
1. Ensure main process does NOT blindly trust child messages
2. Implement snapshot validation (coherence checking, anomaly detection)
3. Log all snapshots for audit trail
4. If validation fails, escalate to guardian (do not silently correct)

---

## 10. Self-Evaluation: Interoception Without Identity Collapse

### The Interoception Problem

**Interoception** is sensing one's own state (heart rate, muscle tension, emotional state). In Sylphie, interoception means:
- **Self KG** contains model of self (capabilities, limitations, current mood)
- **Self-evaluation** reads Self KG and updates drive baselines based on self-model

**The problem:** A self-model that is too negative produces low baselines for all drives. Low baselines make the system less likely to attempt actions. Fewer actions → fewer successes → self-model stays negative. This is the **Depressive Attractor**.

### Interoceptive Accuracy Without Collapse

**Interoceptive accuracy** (Immutable Standard from CANON) is the fidelity of the self-model. The self-model should match reality (what Sylphie can actually do), not be divorced from reality (Sylphie thinks it's incompetent when it's actually skilled).

**Mechanism (E4 responsibility):**
1. Self-evaluation reads Self KG every 10 drive ticks
2. Compares self-model against recent outcomes (last 20 actions, last 100 events)
3. Updates self-model baseline drives based on mismatch
4. **Important:** Self-model changes DO NOT immediately cascade. They affect the *next cycle's* drive baselines, not this cycle.

**Example:**
- Cycle 100: Self-model says "I'm bad at communication" (low Social baseline)
- Cycle 110 (self-evaluation tick): Looks at last 20 actions, finds 80% communication success
- Updates self-model: "I'm actually good at communication"
- Cycle 111: Decision-making uses updated baseline, Social is higher
- Next decision is more likely to attempt social action

**Lag between self-model update and effect:** 1 cycle (~10ms at 100Hz). This decouples the self-model oscillations from real-time decisions.

### Circuit Breaker for Identity Collapse

If the system is in a ruminative loop (repeatedly evaluating self as negative despite evidence of success), the circuit breaker forces behavioral change:

```
IF (last 20 self-evaluations < -0.5) AND (action diversity in last 20 = 0)
THEN:
  - Force action diversification (select from different action category)
  - Reset self-model to neutral baseline (0.5)
  - Emit CIRCUIT_BREAKER_TRIGGERED event
```

This is a **hard reset**. It overrides the self-model. It's drastic but prevents identity collapse.

**When would circuit breaker trigger?**
- System has experienced failures in a narrow domain (e.g., tries to communicate and fails 10x)
- Self-evaluation sees negative pattern and updates Self KG negatively
- System becomes anxious about communication
- System avoids communication (doesn't try alternative action types)
- Self-evaluation sees persistent negative self-model and lack of behavior change
- Circuit breaker fires

**What happens next:**
- System is forced to try a different action type (e.g., explore instead of communicate)
- Different action type succeeds
- Success provides evidence against negative self-model
- System re-evaluates
- Self-model becomes more neutral
- Confidence returns
- System can attempt communication again, but with different approach (learned from forced exploration)

### Self-Evaluation Timescale Validation

**Hypothesis:** Self-evaluation every 10 drive ticks prevents identity collapse. Without this timescale separation, the system oscillates.

**Validation test:**
1. Simulate system with repeated failure in one domain (e.g., communication)
2. Run with self-evaluation every tick (no separation)
3. Measure: Does self-model collapse (self-valence → -1.0)?
4. Repeat with self-evaluation every 10 ticks
5. Measure: Does self-model stay bounded (-0.5 < self-valence < 0.5)?
6. Run with circuit breaker active
7. Measure: Is ruminative loop detected and broken?

**Expected results:**
- Every tick: system collapses (identity lock-in)
- Every 10 ticks: system oscillates but stays bounded
- With circuit breaker: system escapes oscillation in 2-3 seconds

**For E4:** Implement simulation framework to validate these hypotheses before committing to exact timescale values.

---

## 11. Summary: Drive Engine as Cybernetic Control

### The Five Layers of Control

The Drive Engine achieves control over Sylphie's behavior through five nested layers:

**Layer 1: Drive computation** (what pressures matter?)
- 12 drives with distinct relief conditions
- Cross-modulation rules (drives affect each other)
- ACT-R-like confidence dynamics (learning from outcomes)

**Layer 2: Drive-affect coupling** (do drive states actually affect behavior?)
- Drive state is injected into Type 1/Type 2 arbitration
- Cognitive Awareness affects threshold
- Anxiety affects decision confidence

**Layer 3: Evaluation function** (how is success measured?)
- Fixed: Immutable Standard 6 (cannot be self-modified)
- Three-layer boundary: code, process, database
- Guardian asymmetry provides external ground truth

**Layer 4: Homeostatic regulation** (are essential variables maintained?)
- Satisfaction-Boredom for diversity
- Cognitive Awareness for Type 1/Type 2 ratio
- Confidence dynamics for prediction accuracy
- Guardian feedback for external alignment

**Layer 5: Attractor state prevention** (are pathological states avoided?)
- Cold-start dampening
- Opportunity decay
- Self-evaluation timescale separation
- Circuit breakers for ruminative loops

### What the Drive Engine Enables

**If the Drive Engine is implemented correctly:**

1. **Behavioral personality emerges** from contingencies, not targets. The system's personality is the trajectory through drive state space, shaped by learning history and guardian feedback.

2. **Genuine learning occurs** because drive relief is contingent on specific behaviors. The system is motivated to improve.

3. **Autonomy develops** from Type 1 graduation. As the graph grows and prediction improves, more decisions are made without LLM assistance.

4. **Stability is maintained** through homeostatic mechanisms. Essential variables stay within bounds.

5. **Self-modification is prevented** through three-layer isolation. The evaluation function is fixed architecture.

### What Goes Wrong Without Careful Implementation

**If the Drive Engine is implemented carelessly:**

1. **System becomes Type 2-dependent** if Type 2 cost is too low or Cognitive Awareness coupling is weak.

2. **System becomes depressed** if self-evaluation runs too fast or circuit breaker is missing.

3. **System fills with low-quality plans** if cold-start dampening is too weak or opportunity decay is missing.

4. **System gets stuck** if satisfaction habituation curve is wrong or Boredom drive is missing.

5. **System drifts from design intent** if rule governance is not strictly enforced or guardian review is lax.

---

## 12. Recommendations for Epic 4 Planning

### Tier 1: Critical (Must have for E4 to function)

1. **Separate process for Drive Engine** with one-way IPC (typed messages, no remote procedure calls)
2. **Drive computation logic**: 12 drives, cross-modulation rules, ACT-R confidence dynamics, self-evaluation on slower timescale
3. **Three-layer isolation boundary**: code-level interface, process-level boundary, database-level RLS
4. **Cold-start dampening** with ramping schedule (aggressive first 50 cycles, then ramps up)
5. **Opportunity detection** from prediction failures, with priority decay
6. **Behavioral contingency rules** from CANON (satisfaction habituation, anxiety amplification, guilt repair, etc.)
7. **Health monitoring**: watchdog timer for Drive Engine process, snapshot validation
8. **Guardian alert system** for anomalies (stuck drives, incoherent snapshots, ruminative loops)

### Tier 2: Important (strong validation)

9. **Simulation framework** to validate:
   - Cold-start phase transition (reaches Phase 1 by cycle 300)
   - No system oscillation under feedback
   - Attractor state prevention (system does not converge to known bad states)
   - Self-evaluation interoceptive accuracy
   - Drive cross-modulation coupling strengths

10. **Telemetry events** for monitoring:
    - `DRIVE_SNAPSHOT` (every 100-1000 cycles, sampled)
    - `OPPORTUNITY_CREATED` (every opportunity)
    - `RULE_EVALUATED` (every rule evaluation)
    - `SELF_EVALUATION_EVENT` (every self-eval cycle)
    - `PHASE_TRANSITION` (cold-start, early learning, consolidation, mature)

11. **Rule governance infrastructure**:
    - `proposed_drive_rules` table with status tracking
    - Rule performance monitoring (guardian sees metrics)
    - Rule deprecation without deletion (audit trail)

12. **Cognitive Awareness - Type 1 Threshold coupling**:
    - Validate coupling strength through simulation
    - Tune so that Type 1 ratio increases from cold start to Phase 2

### Tier 3: Nice-to-have (optimizations)

13. **Information gain audit system** (Drive Engine computes information gain independently, compares vs. Learning's report)

14. **Coupling strength matrix** (explicitly document 12×12 cross-modulation matrix, validate through simulation)

15. **Attractor state baselines** (periodic "health check" queries to detect proximity to known attractors)

16. **Guardian interaction analytics** (track guardian correction/confirmation rates per action type, per domain)

### Implementation Order Recommendation

1. **Scaffold** (E0 infrastructure)
2. **Database + Events + Knowledge** (E1-E3)
3. **Drive Engine process isolation + 12-drive computation** (Tier 1, items 1-2)
4. **Evaluation boundary + health monitoring** (Tier 1, items 3-8)
5. **Simulation framework** (Tier 2, item 9)
6. **Telemetry + rule governance** (Tier 2, items 10-11)
7. **Coupling validation** (Tier 2, item 12)
8. **Polish + optional enhancements** (Tier 3)

**Critical path:** E0 → E1/E2/E3 → Drive process isolation → Drive computation → Evaluation boundary → Health monitoring → Validation through simulation → Rule governance.

**Do NOT skip simulation validation.** The system's long-term behavior depends on correct tuning. Simulation reveals attractor states and phase transitions before they happen in the real system.

---

## 13. Integration Checklist with Other Epics

| Aspect | Responsibility | Other Epic | Handoff |
|--------|----------------|-----------|---------|
| Event stream for drive computation | E4 reads TimescaleDB | E2 | Drive Engine queries must be efficient; E2 provides indexing |
| Prediction outcomes for opportunity detection | E4 evaluates prediction errors | E5 | Decision Making emits `OUTCOME_OBSERVED` events with prediction context |
| Information gain verification | E4 validates information_gain | E3 | Learning reports nodes created; Drive Engine audits WKG |
| Guardian feedback integration | E4 applies weights (2x/3x) | E6 | Communication reports `GUARDIAN_CORRECTION` with confidence weight |
| Opportunity consumption | E4 creates Opportunities | E8 | Planning consumes Opportunity queue; reports plan performance |
| Self-model interoception | E4 evaluates Self KG | E3 (Grafeo) | Self KG must be queryable and updatable by Drive Engine |
| Behavioral contingency firing | E4 implements contingencies | ALL | Each contingency references action outcomes; ALL subsystems must emit outcome events |

---

## 14. Theoretical Grounding: Homeostasis, Requisite Variety, Ultrastability

### Homeostasis
Ashby (1948): "Homeostasis is the property of a system in which a number of variables are so interrelated by negative feedback as to cause the maintenance of some essential variables within assignable limits."

**Sylphie:** Essential variables are Type 1 ratio, prediction MAE, behavioral diversity, drive entropy, interoceptive accuracy, mean drive resolution time. Negative feedback loops (satisfaction habituation, confidence decay, Boredom drive, Cognitive Awareness pressure) maintain these within healthy ranges.

### Requisite Variety
Ashby (1956): "Only variety can absorb variety. A regulator can only control a system if the regulator has at least as much variety as the system being regulated."

**Sylphie:** Environmental variety is enormous (all possible conversational contexts, prediction domains, guardian feedback styles). Drive Engine variety is limited (12 drives, 20-30 rules). This is sufficient because drives are **abstract** and rules apply broadly. Novel situations fall to Default Affect + guardian feedback to establish new rules.

### Ultrastability
Ashby (1952): "A system is ultrastable if it can change its own structure in order to adapt to perturbations that would otherwise throw it out of equilibrium."

**Sylphie:** Three-level knowledge graph (instance, schema, meta-schema) enables ultrastability. Instance-level learning (new nodes) maintains equilibrium within existing types. Schema-level learning (new types) adapts when existing types fail. Meta-schema (drive rules, learning rates) can be adapted (by guardian approval) when the system's structure itself is misaligned.

### Self-Reference and Autopoiesis
Humberto Maturana & Francisco Varela (1980): "An autopoietic system is a network of processes that produces the components which, through their interactions, generate the very network that produced them."

**Sylphie is autopoietic:**
- Learning produces knowledge (WKG)
- Knowledge informs Decision Making
- Decisions produce outcomes
- Outcomes inform Learning
- The cycle is self-referential

**Risk:** Autopoietic closure (system becomes internally consistent but externally wrong). Guardian breaks closure by providing external evaluation (corrections, confirmations).

---

## 15. References

- Ashby, W.R. (1948). "Design for a Brain." *Electronic Engineering*, 20(12), 379-383.
- Ashby, W.R. (1952). *Design for a Brain: The Origin of Adaptive Behaviour*. Chapman & Hall.
- Ashby, W.R. (1956). *An Introduction to Cybernetics*. Chapman & Hall.
- Campbell, D.T. (1976). "Assessing the impact of planned social change." In *The Public Science of Public Policy*.
- Kauffman, S.A. (1993). *The Origins of Order: Self-Organization and Selection in Evolution*. Oxford University Press.
- Maturana, H.R., & Varela, F.J. (1980). *Autopoiesis and Cognition: The Realization of the Living*. D. Reidel.
- Wiener, N. (1948). *Cybernetics: Control and Communication in the Animal and the Machine*. MIT Press.
- CANON.md (project document)
- Phase 1 Roadmap (project document)

---

**Analysis completed:** 2026-03-29
**For:** Epic 4 planning and validation
**Authority:** Ashby, Systems & Cybernetics Theorist

**Next steps for project team:** Review this analysis; identify agreement/disagreement with systemic assessments; adjust E4 scope/parameters as needed; commission simulation validation before implementation begins.
