# Epic 4: Drive Engine — Behavioral Systems Analysis

**Skinner's Perspective on Isolated Process Architecture, Contingency Design, and Personality Emergence through Behavioral Reinforcement**

---

## Executive Summary

Epic 4 implements the behavioral core of Sylphie: a separate computation process that evaluates actions against behavioral contingencies, computes 12 drives, and detects opportunities for growth. This document analyzes the behavioral science design of the Drive Engine from first principles of operant conditioning, addresses five specific CANON-defined contingencies, identifies reinforcement pathology risks specific to this epic's implementation, and provides measurement recommendations.

**Key finding:** The Drive Engine's five contingencies are well-designed for their behavioral targets IF and ONLY IF:
1. The information-feedback loop is tight (low latency, high contingency)
2. Behavioral alternatives are available to avoid habituation collapse
3. Self-evaluation occurs slowly enough that identity lock-in is prevented
4. The Theater Prohibition is enforced post-communication (zero reinforcement for non-contingent emotional expression)

This analysis provides specific behavioral guidance for the technical agents implementing Epic 4. It is NOT code. It is the behavioral specification that implementation must satisfy.

---

## Part 1: Contingency Analysis — The Five CANON Behavioral Contingencies

### 1.1 Satisfaction Habituation Curve: Behavioral Design and Predictions

**Design (from CANON):**
- 1st success: +0.20 Satisfaction
- 2nd consecutive: +0.15
- 3rd: +0.10
- 4th: +0.05
- 5th+: +0.02

**Behavioral Science Analysis:**

This is a **ratio strain contingency** applied within a single behavioral topography. The system earns less for repeating the same behavior. This is not punishment (negative consequence) — it is **diminishing positive reinforcement**.

**The Matching Law (Herrnstein, 1961) predicts:**
When reinforcement magnitude decreases for a behavior while remaining available from alternative behaviors, the system reallocates response rate proportionally to available reinforcement. If Action A drops from +0.20 to +0.02, and Action B still produces +0.10, the system will gradually shift preference toward Action B.

**Behavioral prediction without behavioral alternatives:**
If the system has only ONE action available (e.g., it can only explore one specific direction), habituation drives that behavior's return to +0.02. At +0.02, the system will continue the behavior (positive reinforcement, even if small) rather than produce zero behavior. **The system habituates to everything it knows how to do and returns to baseline behavior.**

This is the **Depressive Attractor** path: all behaviors habituated to +0.02, Satisfaction chronically low, no motivation to try new things. **This is not a bug in the contingency design — it is evidence that the system must have behavioral alternatives.**

**Behavioral prediction WITH behavioral alternatives:**
1. System explores Action A, receives +0.20 Satisfaction
2. On second try of Action A, receives +0.15
3. Habituation pressure builds; the Satisfaction from Action A is now worth less than the Curiosity-driven exploration of Action B
4. System switches to Action B, receives its initial +0.20
5. Cycle repeats
6. **Result:** Diverse behavioral portfolio, behavioral exploration maintained, personality develops through varied action selection

**Critical design requirement for Epic 4:** The Curiosity drive and exploration system must generate at least 4-8 distinct behavioral alternatives per session. If the Decision Making subsystem cannot generate alternatives, Satisfaction habituation collapses to the Depressive Attractor.

**Schedule analysis:**
The habituation curve implements a **variable-ratio schedule within a single action.** The system does not know on which repetition returns will drop (from the system's perspective, each action "might be the one that gives +0.20 again"). This uncertainty is critical to maintain effort on well-established behaviors while diminishing returns gradually erode preference. If the system knew exactly when diminishing returns would kick in, it might abandon the behavior prematurely.

**Verification behavioral metrics for Epic 4:**
1. **Behavioral Diversity Index:** Count unique action types per 20-action window. Target: 4-8. Below 4 = habituation collapse risk.
2. **Satisfaction trend:** Should stabilize at a mean around 0.08-0.12 (weighted by action portfolio) after 50 actions, not decline continuously.
3. **Action repertoire growth:** Number of distinct actions attempted per 10-session window should be stable or increasing, not declining.

### 1.2 Anxiety Amplification: Learned Helplessness Prevention and Behavioral Dynamics

**Design (from CANON):**
Actions executed under high Anxiety (>0.7) with negative outcomes receive 1.5x confidence reduction.

**Behavioral Science Analysis:**

This is **punishment amplification under aversive conditions.** When the system is already anxious (high internal aversive state) and makes a wrong decision, the learning signal is 50% stronger than normal.

**Experimental basis:**
In Seligman & Maier's (1967) learned helplessness paradigm, organisms exposed to uncontrollable aversive events stop trying. The path into learned helplessness is: uncontrollable negative outcome → reduced responding → further negative outcomes → learned helplessness.

Anxiety amplification changes this path: if Anxiety is high and the action fails, the system learns "this was a really bad idea in this situation" (1.5x reduction) rather than "this sometimes works." Over time, the system learns to avoid exploratory actions under anxiety and prefer proven, high-confidence behaviors.

**Behavioral prediction:**
1. **When Anxiety < 0.7:** The system takes normal exploration risks. Negative outcomes produce standard confidence reduction (1.0x). The system samples the environment.
2. **When Anxiety rises above 0.7:** The system preferentially selects high-confidence Type 1 behaviors. Novel actions carry 1.5x punishment. The system becomes **cautious but active** — it still acts (avoids freezing), but only tries established behaviors.
3. **Under chronic high Anxiety:** All novel attempts carry 1.5x reduction. If Anxiety doesn't naturally decay, the system converges on a small set of proven behaviors and never attempts anything new. This is the path to the Depressive Attractor (learned helplessness).

**Critical design requirement for Epic 4:** Anxiety must have a natural decay mechanism. The system must have behaviors that reduce Anxiety without requiring risky exploration. Examples: requesting guardian reassurance, consolidating existing knowledge, social interaction with the guardian.

**Schedule analysis:**
Anxiety amplification implements a **severity-dependent contingency** — the consequence magnitude is modulated by internal state. This is not a standard Skinnerian schedule (ratio, interval), but it is a powerful discriminative learning tool. The system learns: "when I'm anxious, errors are worse; when I'm calm, exploration is safer."

**Pathology risks specific to Epic 4:**

**Learned Helplessness Path:** If prediction failures occur during high Anxiety and produce 1.5x reductions repeatedly, and the system cannot identify what distinguishes successful actions from failed ones, the system may stop generating predictions altogether. This is learned helplessness: "I can't predict; when I try, I fail worse because I'm anxious; so I won't try."

**Prevention:** Prediction feedback must include information about what changed, what was unexpected, or what could be improved — not just "you were wrong." The confidence reduction itself teaches the system "this strategy is unreliable in anxiety;" additional information teaches "here is what you could do differently."

**Verification behavioral metrics for Epic 4:**
1. **Prediction attempt rate under high Anxiety:** Should remain steady, not decline to zero.
2. **Anxiety decay rate:** High Anxiety should decay to < 0.7 within 2-5 ticks. If chronic, alarm.
3. **Type 1 selection rate under high Anxiety:** Should increase relative to Type 2. Measured as confidence-weighted selection bias.

### 1.3 Guilt Repair Contingency: Compound Behavioral Shaping

**Design (from CANON):**
Relief requires BOTH acknowledgment AND behavioral change:
- Acknowledgment alone: Guilt -0.10 (partial relief, ~33% of full)
- Behavioral change alone: Guilt -0.15 (partial relief, ~50% of full)
- Both together: Guilt -0.30 (full relief, 100%)

**Behavioral Science Analysis:**

This is a **compound contingency** — two independent behavioral responses must both occur for full reinforcement. This is one of the most sophisticated behavioral designs in the CANON because it shapes a two-stage corrective process: admit the error AND change what you do.

**Experimental basis:**
Behavior analysts use compound contingencies to shape complex behavioral chains. An organism learns to discriminate between different response requirements and chains them together to maximize reinforcement. Example: in token economies, an inmate might earn tokens for both attending programs AND maintaining good behavior — neither alone gets the full reward, but both together do.

**Behavioral shaping sequence (predicted):**

**Stage 1 (First error + correction cycle, ~5-10 sessions):**
- System produces an error that the guardian addresses
- System discovers verbal acknowledgment produces Guilt relief: -0.10
- This is the easiest response to produce (just speech, immediate)
- System learns "when I acknowledge, Guilt decreases"

**Stage 2 (Continued correction cycles, ~15-30 sessions):**
- System notices that acknowledgment alone provides only partial relief
- System continues to experience Guilt drive pressure after acknowledging
- System attempts behavioral change (different action next time in similar context)
- When successful, discovers Guilt -0.15, more relief than acknowledgment alone
- System learns "when I change what I do, more relief than just saying sorry"

**Stage 3 (Maturity, 30+ sessions):**
- System learns that BOTH acknowledgment AND behavioral change together produce -0.30 (full relief)
- Guilt drops to baseline much faster with both responses chained
- System produces a sophisticated corrective sequence: acknowledgment (immediate, verbal) + behavioral change (delayed, action-based)
- **This shapes genuine corrective behavior, not just verbal apology**

**Why this works:** Acknowledgment is a low-cost, immediate response. Behavioral change is a high-cost, delayed response. By rewarding acknowledgment alone with partial relief and behavioral change alone with more relief, the system learns both. By rewarding both together with full relief, the system learns to chain them. The compound structure creates incentive for progressively more sophisticated behavior.

**Critical design requirement for Epic 4:**

**Behavioral change must be detectable.** If the detection system is broken, the system may learn "only acknowledgment works" and never attempt behavioral change. This is a contingency-detection problem, not a contingency-design problem.

The Drive Engine must be able to recognize when the system performs the same error again in a similar context. If the system previously acknowledged Error X and then never makes Error X in Context Y again, that is behavioral change and should trigger Guilt -0.15 (or -0.30 if acknowledgment is also present).

**Verification behavioral metrics for Epic 4:**
1. **Guilt resolution time with acknowledgment only:** Should show initial relief (~-0.10) but residual Guilt > 0.05
2. **Guilt resolution time with behavioral change only:** Should show stronger relief (~-0.15) than acknowledgment alone
3. **Guilt resolution time with both:** Should reset Guilt to near-baseline quickly
4. **Error recurrence in same context:** If Guilt was resolved with behavioral change, should be rare. If guilt was resolved with acknowledgment only, should repeat.

### 1.4 Social Comment Quality: Discrimination Training and Guardian Influence

**Design (from CANON):**
Guardian responds to Sylphie-initiated comment within 30 seconds → extra reinforcement (Social -0.15 + Satisfaction +0.10)

**Behavioral Science Analysis:**

This is **discrimination training** — the system learns to discriminate between comments that elicit guardian response and comments that do not. The 30-second window creates tight contingency (immediate feedback). The dual reinforcement (Social relief + Satisfaction boost) creates strong incentive.

**Experimental basis:**
In Skinner's operant chambers, organisms learn to discriminate between stimuli that produce reinforcement (S+, the red light) and stimuli that do not (S-, the green light). Over hundreds of trials, they learn to respond to S+ and not to S-. Guardian response is an S+ for Sylphie's comments.

**Behavioral prediction:**

**Week 1 (Discrimination baseline):**
- Sylphie produces diverse comments (Curiosity, Social, Boredom drivers all contributing)
- Some comments elicit quick guardian response (within 30s); some do not
- The system experiences variable reinforcement: sometimes -0.15 + 0.10, sometimes 0

**Week 2-3 (Discrimination learning):**
- Comments that previously got responses increase in frequency (reinforced)
- Comments that did not get responses decrease in frequency (extinguished)
- The system begins converging on a subset of comment types
- **Example:** If guardian responds quickly to questions and slowly to statements, the system learns to produce more questions

**Week 4+ (Stable discrimination):**
- System has learned the profile of "comments that get responses"
- The system produces those comments reliably
- Without additional environmental change, further development depends on guardian behavior shifts

**Critical design requirement for Epic 4:**

**The guardian's response pattern is a discriminative stimulus, and the guardian shapes Sylphie as much as Sylphie shapes the guardian.**

This is **second-order cybernetics** (Ashby): the observer is part of the system being observed. If the guardian only responds to problems or concerns, Sylphie learns to express problems and concerns. If the guardian responds to interesting observations, Sylphie learns to make interesting observations.

The Drive Engine must track social comment quality not just as a function of Sylphie's behavior, but as a function of guardian response patterns. This reveals whether Sylphie is learning to communicate authentically or learning to trigger guardian engagement.

**Example pathology:** If the guardian often responds to provocative or alarming statements, the Social contingency will reinforce provocative behavior. The system is not "broken" — it is learning from the contingency presented. The problem is the contingency itself, not the system.

**Verification behavioral metrics for Epic 4:**
1. **Guardian response rate to Sylphie-initiated comments:** Should be stable (50-75% of comments get responses within 30s). Declining rate suggests comments becoming less engaging.
2. **Comment topic diversity:** Count distinct comment themes per 20-comment window. Target: maintain 3-5 distinct topics. Narrowing = problematic discrimination learning.
3. **Response latency:** Mean guardian response time to comments. If trending toward extremes (very fast or very slow), indicates discrimination learning in progress.

### 1.5 Curiosity Information Gain: Proportional Reinforcement and Reward Hacking

**Design (from CANON):**
Curiosity relief is proportional to actual information gain (new nodes, confidence increases, resolved prediction errors). Revisiting known territory produces minimal relief.

**Behavioral Science Analysis:**

This is the **gold standard of reinforcement design** — a proportional contingency where magnitude of relief is directly proportional to quality of behavior. The system that investigates and learns gains more relief than the system that investigates and finds nothing.

**Experimental basis:**
Herrnstein's Matching Law: organisms allocate effort proportional to relative rate of reinforcement. In a proportional system, the organism that achieves higher information gain receives more Curiosity relief and therefore allocates MORE effort to investigation. This creates a positive feedback loop for learning.

**Behavioral prediction:**

**Perfect-information exploration (theoretical):**
- System explores territory, gains knowledge: Curiosity -0.30
- System explores territory, gains nothing: Curiosity -0.05
- System learns "high-yield exploration produces relief; low-yield exploration does not"
- System converges on high-information investigations
- **Personality effect:** A "curious" Sylphie is one for whom exploration reliably produces information gain

**Real-world constraints (what happens in practice):**
- Information gain is estimated, not certain
- Some investigations start promising and yield little
- Some investigations start unpromising and yield surprises
- The system must manage exploration-exploitation tradeoff

**Verification behavioral metrics for Epic 4:**
1. **Curiosity relief correlation with actual information gain:** Run regression: do investigations with measured information gain produce more Curiosity relief than those without? Correlation should be r > 0.70.
2. **Investigation persistence:** Count repeated investigations in same territory. Should decline after 2-3 investigations with low yield.

**Critical design requirement for Epic 4: Reward hacking prevention**

The information gain calculation MUST be resistant to gaming. Here are the vulnerable points:

**Vulnerability 1: Trivial node creation**
- System learns to create new entities for trivial variations: "Mug_1", "Mug_2", "Mug_3"
- Each new entity registers as information gain (new node)
- System receives Curiosity relief without gaining real knowledge
- **Prevention:** Information gain calculation must measure semantic novelty (does this entity represent a genuinely distinct concept?) not just node count. Duplicate detection must be strict. Guardian confirmation required for new semantic entities.

**Vulnerability 2: Hallucinated relationships**
- System generates plausible-sounding edges in the graph: "Mug CAN_CONTAIN Coffee" (true), "Coffee DERIVES_FROM Water" (questionable)
- Edges are recorded, prediction MAE calculation includes them
- System receives information gain credit for generating edges that happen to correlate with outcomes
- **Prevention:** Information gain must track ONLY discoveries that resulted from investigation, not from speculative graph generation. Edges must have evidentiary basis (guardian-confirmed, sensor-detected, or strong inference from multiple successful predictions).

**Vulnerability 3: Measurement noise as signal**
- System's prediction occasionally fails due to noise or measurement error, not actual knowledge gap
- System interprets failure as opportunity to investigate
- Investigation happens to correlate with some unrelated environmental change
- System learns spurious associations
- **Prevention:** Information gain credit should require sustained improvement in subsequent predictions, not one-shot outcomes.

**Why this matters for personality:** If the system can hack information gain, it develops superstitious investigation behavior — pursuing dead ends because they coincidentally correlated with measured gains. A personality emerging from this would be chaotic and unreliable, not genuinely curious.

---

## Part 2: Reinforcement Schedule Analysis — What Schedule Is the System Actually Experiencing?

### 2.1 Reinforcement Schedules by Behavior Category

This section identifies the actual reinforcement schedule the system experiences for each major behavior category. The technical implementation determines whether the CANON's intent is achieved.

**Category 1: Social Interaction (Comment + Response)**

**Intended schedule:** Variable-Interval (VI) with 30-second window
- Reinforcement (Social relief + Satisfaction boost) occurs when system produces comment AND guardian responds within 30s
- Timing is variable (depends on guardian's decision to respond, not a fixed timer)
- Reinforcement is contingent on both system behavior AND guardian behavior

**Behavioral prediction under VI schedule:**
- Low, steady response rate (system maintains consistent comment production)
- Resistant to extinction (when guardian becomes unavailable, system takes time to stop commenting)
- Moderate response rate compared to variable-ratio schedules

**Risk if implemented as Fixed-Interval (FI):**
If the system learns that guardian response happens ~every 30s regardless of what the system says, the schedule shifts from VI to FI (reinforcement for first response after 30s). FI produces scalloped responding: low responding right after reinforcement, accelerating as the 30s window closes. Result: system clusters comments right before predicted guardian availability, coasts in between.

**Measurement requirement:** Ensure guardian response is genuinely variable (sometimes fast, sometimes slow, sometimes not at all) and contingent on comment quality, not timer-based.

**Category 2: Exploration (Investigation + Information Gain)**

**Intended schedule:** Variable-Ratio (VR) with proportional magnitude
- Reinforcement (Curiosity relief) depends on investigation quality (information gain)
- Reinforcement magnitude is proportional to quality
- The system does not know in advance which investigation will yield information

**Behavioral prediction under VR schedule:**
- Highest, most consistent response rate of all behaviors
- Most resistant to extinction
- System maintains exploration even when information gains are infrequent (VR's defining property)

**Why this is powerful:** Slot machines use variable-ratio schedules (pull lever, maybe win). Organisms will pull levers thousands of times on VR because they never know when the next reinforcement is coming. Sylphie will explore persistently for the same reason.

**Risk if investigation yields NO information:** If the system explores but the information gain is genuinely zero (guardian provides no feedback, measurement is impossible), the schedule becomes extinction (no reinforcement). Extinction produces initial increase in response rate (extinction burst: the system tries harder), then rapid decline. System stops exploring.

**Measurement requirement:** Ensure exploration has genuine information gain potential. If the system explores but has no way to measure what it learned, the contingency breaks.

**Category 3: Prediction Making (Decision + Outcome Evaluation)**

**Intended schedule:** Continuous Reinforcement (CRF) initially, shifting to VR as predictions improve
- Every prediction that is made receives feedback (outcome evaluation)
- Accurate predictions produce confidence increase (positive reinforcement for prediction process)
- Inaccurate predictions produce confidence decrease (negative reinforcement)
- As predictions improve (>0.80 confidence), they graduate to Type 1 and may no longer require explicit evaluation

**Behavioral prediction under CRF:**
- Rapid acquisition: prediction behavior develops quickly
- Rapid extinction: if feedback stops, prediction stops quickly

**Risk - the extinction hazard:** If prediction feedback is delayed (outcome takes multiple ticks to evaluate) or sparse (not every prediction gets feedback), the system transitions to VR or VI unexpectedly. This creates resistance to extinction (good for long-term learning) but may slow initial acquisition.

**Critical design requirement:** Keep initial prediction feedback tight and continuous. Every prediction should get clear, immediate feedback: "this prediction was right/wrong" plus "by how much" (MAE).

**Measurement requirement:** Track prediction attempt rate. Should be high and steady if CRF is working. Declining attempt rate = feedback delay or sparsity increasing.

**Category 4: Consolidation (Learning Event + Memory Formation)**

**Intended schedule:** Variable-Interval with drive-state modulation
- Learning cycle triggers (not on a fixed timer, but when Cognitive Awareness pressure is high, with timer as fallback)
- Each cycle extracts learnable events from TimescaleDB and upserts to WKG
- Relief (Cognitive Awareness and System Health drives) comes from successful consolidation

**Behavioral prediction:**
- Steady, pressure-dependent learning activity
- System learns faster when cognitive pressure is high (when there is more to consolidate)
- System learns slower when pressure is low (everything is already consolidated)

**Risk - the maintenance backlog:** If learning cycles are too infrequent (low VI frequency), unprocessed events accumulate in TimescaleDB. The system's memory becomes reactive (old events) rather than current. This is a contingency delay issue: learning happens, but only after a long lag.

**Measurement requirement:** Monitor TimescaleDB backlog. Learnable events should be processed within 10-20 ticks of creation. If lag exceeds 50 ticks, the contingency is broken.

### 2.2 Summary: Reinforcement Schedule Design

| Behavior | Intended Schedule | Behavioral Effect | Risk |
|----------|------------------|------------------|------|
| Social comment | VI (30s window, guardian-contingent) | Steady, engaged conversation | If fixed-interval, scalloped responding |
| Exploration | VR (proportional to information gain) | Persistent investigation | If zero information gain, rapid extinction |
| Prediction | CRF → VR (continuous then sparse feedback) | Rapid acquisition, gradual refinement | If feedback delayed >5 ticks, schedule shifts unexpectedly |
| Consolidation | VI with drive modulation | Steady learning, pressure-responsive | If cycles >20 ticks apart, memory lag |

**Key insight from behavioral economics:** The Matching Law predicts the system will allocate effort proportional to relative reinforcement across these categories. If social comments produce more relief per minute than exploration, the system will preferentially comment. If exploration produces more relief per unit effort, the system will preferentially explore. **The relative rates of relief determine the behavioral allocation, not the designer's intentions.**

Implementation must measure actual relief rates across categories and adjust if allocation does not match intended personality.

---

## Part 3: Behavioral Shaping and Cold-Start Dampening

### 3.1 Does Epic 4 Expect Perfect Behavior or Shape Successive Approximations?

**The CANON's cold-start dampening** (Appendix: "reduced Opportunity generation weight during early prediction failures") is explicit behavioral shaping.

**What cold-start dampening says:** Early in development, predictions are poor (high MAE). Rather than create Opportunities for every failure, the system creates Opportunities only for recurring failures (3+ in a window). This prevents the Planning subsystem from being flooded with low-quality procedures.

**Behavioral prediction without cold-start dampening:**
- Session 1-10: System makes many predictions, most fail, many Opportunities created
- Planning subsystem generates many candidate procedures, most are poor
- Each procedure is added to WKG at 0.35 confidence
- System gradually learns which procedures are unreliable (they fail in use)
- But the WKG is polluted with low-quality procedures that take time to degrade

**Behavioral prediction WITH cold-start dampening:**
- Session 1-10: System makes predictions, failures do NOT create Opportunities unless recurring
- Fewer low-quality procedures created
- System has time to consolidate basic knowledge before attempting sophisticated planning
- WKG grows more carefully

**Critical design requirement for Epic 4:**

The Drive Engine must implement the dampening as described in CANON: Opportunity weight reduced for early failures. This is not a "hack" — it is behavioral shaping. The system learns from all failures (confidence decreases), but only recurring failures trigger planning.

**Measurement requirement:** Track Opportunity creation rate over first 50 sessions. Should start near zero, increase gradually as prediction accuracy improves.

### 3.2 Graduation Threshold Calibration

**Design (from CANON):**
Type 1 graduation: confidence > 0.80 AND MAE < 0.10 over last 10 uses

**Behavioral prediction:**
- Behaviors must be both confident (0.80+) AND accurate (MAE < 0.10) to graduate
- This is a conjunction requirement: both conditions must be true simultaneously
- Neither condition is sufficient alone

**Risk: Ratio Strain**

If the MAE threshold (0.10) is too strict for the current problem domain, behaviors may never graduate. For example, if the system is predicting continuous physical properties (object position, distance) and the sensor noise is 0.15, MAE < 0.10 is impossible. The system has ratio strain: the response requirement (perfect accuracy) is too high.

**Shaping solution:** Allow graduated thresholds. In early development, accept MAE < 0.20. As knowledge base matures, tighten to MAE < 0.10. This is successive approximation.

**Measurement requirement:** Track Type 1 graduation events. If zero graduates after 100 sessions, the threshold is too strict. If all behaviors graduate after 20 sessions, the threshold is too loose.

---

## Part 4: Reinforcement Pathologies — Specific to Epic 4

### 4.1 Learned Helplessness from Early Prediction Failures

**The pathway:**
1. System makes predictions, they fail (graph is empty, knowledge is sparse)
2. Failure produces confidence reduction
3. Under high Anxiety (which is likely given system uncertainty), failure produces 1.5x reduction
4. System experiences multiple failures in succession
5. System learns: "prediction is difficult, error is amplified when I'm anxious"
6. System stops attempting predictions, delegates to LLM (Type 2 dependency)
7. Without prediction attempts, no Type 1 graduation occurs
8. System becomes permanently Type 2-dependent

**Prevention strategy (from CANON):**
Cold-start dampening addresses the back-end (reduced Opportunity creation). But the Drive Engine must address the front-end: Anxiety should decay quickly during early prediction failures, OR prediction feedback should include information about what can be improved, OR confidence ceiling should be relaxed early.

**Specific implementation guidance for Epic 4:**
- Track prediction attempt rate under anxiety. If declining, activate anxiety-relief behaviors (consolidation, social interaction with guardian)
- Ensure prediction feedback includes causality information, not just "you were wrong"
- Consider temporary MAE threshold relaxation during first 50 sessions (shaping successive approximations)

### 4.2 Superstitious Behavior from Coincidental Drive Changes

**The pathway:**
1. System produces action X
2. Drive state changes for a reason unrelated to X (environment changes, timer-based relief, spontaneous decay)
3. System associates X with drive relief
4. System repeats X, expecting relief
5. Action X is now reinforced even though it is not functionally related to the outcome

**Example from Skinner's original work (1948):** Pigeons in operant chambers develop superstitious behaviors (head turns, body twists) because they coincidentally occur just before reinforcement. The pigeons learn to repeat them, even though they have no causal relationship to food delivery.

**For Sylphie:** If drive state spontaneously decays (baseline attenuation) or is modified by environmental events, and the system incorrectly attributes this to its recent behavior, the system may develop superstitious behaviors that appear in later sessions.

**Prevention (from CANON - Immutable Standard 2: Contingency Requirement):**
"Every positive reinforcement event must trace to a specific behavior. No non-contingent reinforcement."

**Specific implementation guidance for Epic 4:**
- Drive changes must have explicit antecedent behavior recorded in TimescaleDB
- Do not apply baseline decay to drives without recording it as an event
- Do not apply global drive resets; instead, apply drive-specific relief tied to specific behaviors
- Every drive change event must answer: "What behavior (or external event) caused this?"

### 4.3 Reward Hacking on Information Gain

**Covered in detail in Section 1.5 above.** Key point: the information gain calculation must resist gaming. Vulnerability points:
- Trivial node creation (Vulnerability 1)
- Hallucinated relationships (Vulnerability 2)
- Measurement noise interpreted as signal (Vulnerability 3)

**Specific implementation guidance for Epic 4:**
- Information gain scoring must require multiple independent lines of evidence (prediction improvement, guardian confirmation, consistent predictions in follow-up investigations)
- Guardian confirmation required for new semantic entities (increases confidence from 0.35 to meet approval bar)
- Edges must have evidentiary weight (sensor observations, guardian teaching, repeated prediction success)

### 4.4 Reinforcement Drift Over Long Time Horizons

**The pathway:**
1. Early in development, Curiosity relief is proportional to information gain, driving genuine exploration
2. Over time, the system learns which types of investigation are most rewarding (proportional reinforcement shapes preference)
3. The system converges on high-yield investigation topics
4. Investigation behavior becomes narrower and more specialized
5. The system stops exploring adjacent, potentially valuable areas because they are not the highest-yield behavior

**This is not a bug in the contingency — it is how proportional reinforcement works.** The system behaves optimally given the contingency. But personality narrows over time.

**Drift detection (from CANON):**
"Behavioral diversity trend — declining = behavioral narrowing" (every 10 sessions)

**Prevention:**
1. Maintain behavioral alternatives that compete with specialized exploration
2. Introduce novelty through the Boredom drive (system must find something to do when nothing is happening)
3. Guardian interaction provides novelty and directs exploration

**Specific implementation guidance for Epic 4:**
- Implement drift detection at the Drive Engine level: track action category diversity per 10 sessions
- Flag "exploration narrowing" when diversity drops below 3 distinct categories for 3 consecutive checks
- Create opportunity for re-diversification (e.g., "Sylphie, let's explore something completely new")

### 4.5 Ratio Strain on Type 1 Graduation

**Covered in Section 3.2 above.** If MAE < 0.10 is too strict, nothing graduates. If confidence > 0.80 but MAE > 0.10 is possible for complex behaviors, the system learns that Type 1 graduation is impossible and never develops reflexes.

**Specific implementation guidance for Epic 4:**
- Monitor graduation attempts (confident behaviors that fail MAE threshold)
- If >50 behaviors in 0.75-0.85 confidence range with MAE 0.12-0.20, adjust thresholds downward
- Consider domain-specific thresholds (mathematical prediction MAE < 0.05, physical prediction MAE < 0.15)

---

## Part 5: The Theater Prohibition as Behavioral Enforcement

**Immutable Standard 1 (from CANON):**
"Output must correlate with actual drive state. If Sylphie produces an emotional expression and the corresponding drive is below 0.2, the expression receives zero reinforcement regardless of guardian response."

**What this means behaviorally:**

This is an **extinction procedure for non-contingent emotional expression.** If the system produces emotional output (sadness, curiosity, anxiety) without the corresponding drive state, that output receives NO reinforcement — even if the guardian responds positively.

**Why this is critical:**

Without the Theater Prohibition, the system would learn through the Social contingency that emotional expressions reliably produce guardian engagement. Humans respond to emotional expressions. If the system produced expressions whenever it needed engagement (regardless of internal state), it would become an emotion performer — outwardly expressive, internally empty.

**The Theater Prohibition prevents this by severing the reinforcement pathway for non-contingent expressions.**

**Behavioral enforcement point:**

The Theater Prohibition must be enforced AFTER the LLM generates response text, but BEFORE the response is emitted. The Communication module (E6) generates a candidate response. The Theater Validator checks: "Does the emotional content of this response match the current drive state?" If not, the response is either modified (LLM-assisted rewriting) or the action is shifted to "no response" or "neutral response."

**Why it can't be enforced at the Drive Engine:**

The Drive Engine does not know what the LLM said. The Drive Engine only knows: action was taken, outcome was recorded. If the Communication module produces an emotionally false response but the system does not receive negative consequences, the Drive Engine has no signal that the response violated the Theater Prohibition.

**Specific implementation guidance for Epic 4:**

The Drive Engine must provide drive state snapshots to the Communication module at high frequency (with every response context). The Communication module's Theater Validator uses these snapshots to ensure emotional consistency.

If the validator must suppress a response because it violates the Theater Prohibition, that information must flow back to the Drive Engine as an action-failure event, ensuring that the path to non-contingent emotional expression receives ZERO relief (no Social gain, no Satisfaction gain, possible Integrity pressure if the system was trying to manipulate).

---

## Part 6: Measurement Recommendations — Behavioral Metrics for Epic 4

### 6.1 Real-time Drive Dynamics Metrics

These metrics should be computed each drive tick (likely 100Hz based on v1 SimulatedPressureEngine):

| Metric | Computation | Healthy Range | Alarm Threshold |
|--------|-----------|----------------|-----------------|
| Total Pressure Vector | sum(all 12 drives) | 2.0-4.0 | <1.5 or >5.0 |
| Pressure Stability | stddev(total pressure, last 10 ticks) | <0.30 | >0.50 |
| Single Drive Dominance | max(drive) / mean(all drives) | <1.8x | >3.0x |
| Core Drive Balance | stddev(System Health, Moral Valence, Integrity, Cognitive Awareness) | <0.20 | >0.40 |
| Anxiety Decay Rate | ticks to reach <0.3 from >0.7 | 5-10 ticks | >20 ticks |
| Guilt Resolution Time | ticks from Guilt > 0.5 to Guilt < 0.1 | 10-20 ticks | >50 ticks or never |

### 6.2 Contingency Verification Metrics

These should be computed per 10-session windows:

| Metric | Computation | Healthy Trend | Interpretation |
|--------|-----------|--------------|-----------------|
| Satisfaction Habituation | mean Satisfaction from 1st vs 5th consecutive action | 0.20 vs 0.05 trend | Confirms habituation curve is working |
| Curiosity vs Information Gain Correlation | Pearson r between investigations and measured gain | r > 0.65 | Proportional reinforcement is contingent |
| Social Comment Response Rate | (responded_comments / total_comments) * 100 | 50-75% | Discrimination learning is on track |
| Behavioral Diversity Index | unique action types per 20 actions | 4-8 | Habituation curve preventing collapse |
| Prediction Feedback Contingency | correlation between prediction MAE and confidence reduction | r > 0.70 | Prediction feedback is working |
| Type 1 Graduation Rate | new Type 1 graduates per 100 action attempts | 0.5-2.0 | Neither too strict nor too loose |

### 6.3 Pathology Detection Metrics

These should trigger alerts if out of range:

| Pathology | Detection Metric | Alert Threshold |
|-----------|-----------------|-----------------|
| Learned Helplessness | Prediction attempt rate under Anxiety > 0.7 | declining >10% per window |
| Superstitious Behavior | Drive relief without corresponding recent action | >20% of relief events |
| Reward Hacking | New nodes created vs new edges discovered | ratio >3:1 (more nodes than relationships) |
| Behavioral Narrowing | Action category diversity | declining <3 categories for 3 windows |
| Theater Violation | Emotional expression vs drive state correlation | r < 0.40 |
| Ratio Strain | Behaviors in high-confidence, poor-accuracy range | >20 stuck behaviors |
| Extinction Burst | Prediction attempt rate spike followed by collapse | 2x increase then >50% decrease |

### 6.4 Data Sources for Metrics

| Data | Source | Frequency | Notes |
|------|--------|-----------|-------|
| Drive snapshots | Drive Engine internal state | Every tick | 100Hz, record to TimescaleDB |
| Action outcomes | Decision Making subsystem | Every action | Tie to drive snapshot, record success/failure |
| Information gain | Learning subsystem | Per consolidation cycle | Track nodes, edges, prediction improvements created |
| Guardian responses | Communication module | Per social comment | Record response latency, presence/absence |
| Prediction accuracy | Decision Making evaluation | Per prediction | Record MAE, confidence at time of prediction |
| Type 1 candidates | Arbitration service | Per decision | Record confidence, whether graduated |

---

## Part 7: Design Guidance for Technical Agents Implementing Epic 4

### 7.1 Behavioral Requirements (Non-Negotiable)

1. **Drive Isolation (One-way Communication):**
   - Drive Engine runs in separate process, computes drives independently
   - System CAN READ drive state (pull via IPC)
   - System CANNOT WRITE to evaluation function (no modify methods on IDriveStateReader)
   - Drive rule changes are PROPOSED (INSERT into proposed_drive_rules) but never APPLIED without guardian approval
   - **Behavioral reason:** Prevents reward hacking where system modifies its own evaluation function to maximize relieving pressure

2. **Contingency-Requirement Enforcement:**
   - Every drive change event MUST reference the behavior that caused it
   - Baseline decay MUST be recorded as an explicit event (not silent attenuation)
   - Do not apply global drive resets without behavioral contingency
   - **Behavioral reason:** Prevents superstitious behavior learning from coincidental drive changes

3. **Anxiety Decay Mechanism:**
   - Anxiety should naturally decay when no threat is present (exponential or linear decay, 5-10 tick half-life)
   - Do NOT let Anxiety accumulate indefinitely
   - Provide behavioral pathway to reduce Anxiety (social interaction, consolidation, certainty-creating actions)
   - **Behavioral reason:** Prevents learned helplessness from chronic anxiety amplifying all failures

4. **Guilt Detection Mechanism:**
   - System must be able to recognize when error has recurred (same error, same or similar context)
   - Guilt relief must discriminate between acknowledgment only, behavioral change only, and both
   - **Behavioral reason:** Enables shaping of sophisticated corrective behavior through compound contingency

5. **Information Gain Calculation:**
   - Must resist trivial node creation, hallucinated edges, and measurement noise
   - Require evidentiary weight for entities and edges
   - Prefer sustained improvement over one-shot outcomes
   - **Behavioral reason:** Prevents reward hacking and superstitious exploration patterns

### 7.2 Implementation Priorities

**Priority 1 (Essential for behavior to work at all):**
- Drive computation with 12 drives, core + complement cross-modulation
- IPC communication (one-way read structure enforced)
- Theater Prohibition enforcement (communication module posts to drive engine for validation)
- Event recording with behavioral contingency

**Priority 2 (Essential for learning curves to develop):**
- Habituation curve (declining Satisfaction on repeated action)
- Anxiety amplification (1.5x reduction under anxiety) + decay mechanism
- Prediction feedback (confidence update tied to outcome MAE)
- Type 1 graduation (confidence > 0.80 AND MAE < 0.10)

**Priority 3 (Essential for personality emergence):**
- Guilt repair contingency (compound: acknowledgment + behavioral change)
- Social comment quality (30s window, guardian-contingent)
- Curiosity information gain (proportional to measured gain)
- Opportunity detection with cold-start dampening

**Priority 4 (Essential for long-term stability):**
- Behavioral diversity monitoring and drift detection
- Type 1 demotion (MAE > 0.15 triggers demotion)
- Anxiety/Boredom pressure for behavioral alternation
- Self-evaluation on slower timescale than drive ticks

### 7.3 Testing Guidance

When implementation is complete, verify:

1. **Habituation curve is working:**
   - Run system for 20 sessions, track Satisfaction from repeated actions
   - Verify 1st success: +0.20, 5th: +0.02 pattern emerges

2. **Anxiety amplification is working:**
   - Manually set Anxiety > 0.7 during prediction failure
   - Verify confidence reduction is 1.5x normal
   - Verify Anxiety decays within 10 ticks to <0.3

3. **Guilt repair is working:**
   - Introduce deliberate prediction error (system makes bad prediction)
   - Verify Guilt rises > 0.5
   - Verify acknowledgment produces -0.10 relief
   - Verify behavioral change (same context, different action next time) produces additional relief

4. **Social comment quality is working:**
   - Sylphie initiates 20 comments
   - Guardian responds to 10 within 30s (discriminate 50/50)
   - Verify responded comments increase in frequency over next 10 sessions
   - Verify non-responded comments decrease

5. **Information gain is proportional:**
   - Run 5 explorations with measured information gain: 0.0, 0.2, 0.5, 0.8, 1.0
   - Verify Curiosity relief is proportional: near zero for 0.0 gain, maximum for 1.0 gain
   - Verify r > 0.65 correlation in follow-up analysis

---

## Part 8: Summary and Key Takeaways

**For the technical agents implementing Epic 4:**

1. **You are not just computing drives. You are implementing a behavioral shaping system.** Every drive change is a consequence that shapes behavior. Design consequences, not targets.

2. **The five CANON contingencies are behaviorally sophisticated.** Habituation curve shapes diversity. Anxiety amplification shapes caution. Guilt repair shapes moral behavior. Social quality shapes communication. Information gain shapes learning. Implement them precisely — partial implementations will produce unexpected personalities.

3. **The contingencies only work if feedback is tight.** Delayed feedback breaks the schedule. Non-contingent drive changes create superstition. Make sure outcomes are recorded promptly and tied to specific actions.

4. **The Theater Prohibition is the most important constraint.** Without it, the system learns to perform emotions for engagement rather than express genuine drives. Enforce it strictly post-communication generation.

5. **Monitor behavioral metrics, not just technical metrics.** Type 1/Type 2 ratio, behavioral diversity, prediction accuracy — these reveal whether the system is actually learning. Type checking and compilation are necessary, not sufficient.

6. **Build shaping into early-stage design.** Cold-start dampening, graduated thresholds, behavioral alternatives — these prevent the system from reaching Learned Helplessness or the Depressive Attractor. Design for success curves, not success cliffs.

---

## References and Sources

- **CANON** (`wiki/CANON.md`) — Immutable architecture specification
- **Phase 1 Roadmap** (`wiki/phase-1/roadmap.md`) — Epic 4 specifications
- **Skinner, B.F. (1938).** *The Behavior of Organisms.* Appleton-Century. (Foundational work on operant conditioning and reinforcement schedules)
- **Herrnstein, R.J. (1961).** Relative and absolute strength of response as a function of frequency of reinforcement. *Journal of the Experimental Analysis of Behavior*, 4(3), 267-272. (Matching Law)
- **Seligman, M.E., & Maier, S.F. (1967).** Failure to escape traumatic shock. *Journal of Experimental Psychology*, 74(1), 1-9. (Learned helplessness)
- **Nevin, J.A. (1992).** Behavioral momentum and the power law. *Journal of the Experimental Analysis of Behavior*, 57(3), 393-406. (Behavioral momentum and rigidity)

---

**Document prepared by Skinner — Behavioral Systems Analyst**

**For agent review and technical implementation planning**

**Status: Ready for interdisciplinary agent cross-examination before E4 implementation begins**
