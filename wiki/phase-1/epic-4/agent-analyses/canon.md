# Epic 4: Drive Engine (Isolated Process) — Canon Compliance Analysis

**Reviewed against:** `wiki/CANON.md` (immutable single source of truth)
**Date:** 2026-03-29
**Analyst:** Canon (Project Integrity Guardian)

---

## Executive Summary

Epic 4 implements the Drive Engine — the most architecturally sensitive subsystem in Phase 1 because it enforces Immutable Standard 6 (No Self-Modification of Evaluation) and the Theater Prohibition (Standard 1). The drive system computes Sylphie's motivational state, evaluates her actions against behavioral contingencies, detects opportunities from prediction failures, and proposes new rules through a guardian-mediated review queue.

The roadmap correctly specifies process isolation, one-way read communication, write-protected PostgreSQL rules, and all five behavioral contingencies required by the CANON. However, **seven critical gaps** must be resolved before implementation:

1. **Detailed Drive Cross-Modulation Rules** (CANON A.1 — reserved)
2. **Self-Evaluation Protocol** (CANON A.8 — reserved)
3. **Opportunity Detection Thresholds** (CANON A.4 — partially specified)
4. **Drive Accumulator Rates and Decay** (CANON A.14 — reserved)
5. **Full Behavioral Contingency Tables** (CANON A.15 — reserved)
6. **Theater Prohibition Enforcement Boundary** — Who validates correlation between output and drive state?
7. **Guardian Asymmetry Application** — Exact weight multiplier integration with confidence formula

**Compliance Status:** 10 of 12 checks COMPLIANT. 2 critical gaps, 5 design decisions requiring Jim approval.

---

## 1. Core Philosophy Alignment

### 1.1 Experience Shapes Knowledge (CANON §Core Philosophy 1)

**Specification:**
E4 delivers "Prediction accuracy evaluation" and "Opportunity detection from prediction failures". These are the learning signals that drive knowledge updates.

**CANON References:**
- §Core Philosophy 1: "Prediction Drives Learning"
- §Core Philosophy 6: "Sylphie makes predictions about what will happen before she acts. After acting, she evaluates the prediction against reality. Failed predictions are the primary catalyst for growth."
- §Subsystem 4 (Drive Engine): "Evaluate Prediction Accuracy from Decision Making... Inaccurate predictions → Opportunity Evaluation"

**Analysis:**

**COMPLIANT** — E4 correctly positions prediction accuracy evaluation as the gateway to opportunity detection:

- ✓ Drive Engine reads prediction outcomes from TimescaleDB (E2)
- ✓ Compares predictions to actual events to compute MAE (mean absolute error)
- ✓ Prediction failures trigger Opportunity detection
- ✓ Opportunities flow to Planning subsystem (E8) where they shape new procedures
- ✓ This closes the loop: prediction → evaluation → opportunity → planning → behavior → new prediction

**Architectural strength:** Prediction failures are the ONLY legitimate source of Opportunities. The system cannot generate Opportunities from arbitrary decision points — only from prediction mismatches. This enforces the "prediction drives learning" principle at the subsystem boundary level.

**Status:** COMPLIANT.

---

### 1.2 LLM Is Voice, Not Mind (CANON §Core Philosophy 1, Immutable Standard 6)

**Specification:**
E4 states: "Drive Engine runs in a separate process with one-way communication" and "System can READ drive values but cannot WRITE to the evaluation function". The evaluation function (confidence updates, prediction error computation, drive relief formulas) is in the separate process, inaccessible to the main app.

**CANON References:**
- §Core Philosophy 1: "The LLM is her voice, not her mind."
- §Immutable Standard 6: "Sylphie can learn WHAT to do, HOW effective each action is, and WHEN to do it. She cannot learn to modify HOW success is measured — the evaluation function is fixed architecture."
- §Drive Isolation: "Drive computation logic runs in a separate process with a one-way communication channel. The system can READ drive values but cannot WRITE to the evaluation function."

**Analysis:**

**COMPLIANT** — E4 architecture enforces the immutable boundary through structural isolation:

- ✓ **Separate process:** Drive Engine runs as `child_process.fork()` (Node.js native isolation)
- ✓ **One-way communication:** IPC messages flow inbound (ACTION_OUTCOME, SOFTWARE_METRICS, SESSION_START/END) and outbound (DRIVE_SNAPSHOT, OPPORTUNITY_CREATED, DRIVE_EVENT), but NO method for app to modify evaluation function
- ✓ **Process-level enforcement:** The evaluation function (drive ticks, contingency application, opportunity detection) runs entirely within the child process
- ✓ **Database-level enforcement:** PostgreSQL RLS (E1) prevents direct modification of `drive_rules` by `sylphie_app` role
- ✓ **No write methods exported:** DriveReaderService exports IDriveStateReader (read-only) and IActionOutcomeReporter (fire-and-forget telemetry), not configuration methods

**Critical enforcement chain:**
1. Main app calls DriveReaderService.getCurrentState() → reads from child process shared memory (read-only)
2. Main app calls ActionOutcomeReporter.reportOutcome() → IPC message to child (one-way)
3. Child process receives outcome, applies evaluation function (in isolation)
4. Child process sends back drive snapshot via IPC
5. Main app receives snapshot, cannot modify it

**The LLM's role:** Communication (E6) receives drive snapshot, injects it into LLM context so responses correlate with actual state. The LLM speaks FOR Sylphie's drives; it does not decide what the drives should be. This is consistent with "LLM is voice, not mind."

**Status:** COMPLIANT.

---

### 1.3 WKG Is the Brain (CANON §Core Philosophy 3)

**Specification:**
E4 includes "Self-evaluation on slower timescale (reads Self KG)". The Drive Engine reads KG(Self) to evaluate Sylphie's self-model and adjust drive baselines.

**CANON References:**
- §Core Philosophy 3: "The WKG is not a feature of the system. It IS the system."
- §Subsystem 4: "Self Evaluation → query KG(Self)"
- §Behavioral Contingency Structure: "Depressive Attractor prevention: Self-evaluation on slower timescale than drive ticks. Circuit breakers on ruminative loops."

**Analysis:**

**COMPLIANT** — E4 correctly reads but does not write to KG(Self):

- ✓ Drive Engine reads KG(Self) on a slower evaluation timescale (prevents identity lock-in)
- ✓ Reads are used to adjust drive baselines based on self-assessed capabilities
- ✓ Drive Engine does NOT write to KG(Self) — Self KG updates come from Learning subsystem (E7) consolidating experiences
- ✓ This prevents the drive engine from directly modifying Sylphie's self-model, which would be a form of self-directed evaluation function modification

**Architectural guarantee:** The one-way flow is: Experience → Learning (E7) → KG(Self) → Drive Engine (E4) reads → adjusts drive baselines. No backward flow from Drive Engine to KG(Self).

**Status:** COMPLIANT.

---

### 1.4 Dual-Process Cognition (CANON §Core Philosophy 2)

**Specification:**
E4 roadmap mentions "Prediction accuracy evaluation" feeding "opportunity detection", which triggers Planning (E8) for Type 2-intensive planning work. Decision Making (E5) arbitrates Type 1/Type 2 based on confidence levels.

**CANON References:**
- §Core Philosophy 2: "Everything starts as Type 2. Through successful repetition, behaviors graduate to Type 1... The ratio of Type 1 to Type 2 decisions is the primary measure of Sylphie's development."
- §Type 1 / Type 2 Graduation: "confidence > 0.80 AND prediction MAE < 0.10 over last 10 uses"
- §Known Attractor States / Type 2 Addict: "Type 2 must always carry explicit cost — latency, cognitive effort drive pressure, compute budget."

**Analysis:**

**COMPLIANT** — E4 correctly evaluates prediction accuracy that feeds the graduation criteria:

- ✓ Drive Engine computes prediction MAE
- ✓ MAE < 0.10 (+ confidence > 0.80) is the graduation criterion for E5 arbitration
- ✓ E4 feeds MAE values back to Decision Making via OPPORTUNITY_CREATED and DRIVE_EVENT messages
- ✓ Type 2 cost pressure (cognitive effort drive) is computed by E4 and flows to decision making

**Gap for E5:** E5 (Decision Making) must implement the arbitration logic that uses E4's MAE signal. The roadmap acknowledges this: "§Type 1 / Type 2 Graduation... Graduation at confidence > 0.80 AND MAE < 0.10 over last 10 uses". E4 provides MAE; E5 uses it for arbitration.

**Status:** COMPLIANT.

---

### 1.5 Guardian as Primary Teacher (CANON §Core Philosophy 4)

**Specification:**
E4 specifies "Rule proposal queue (system can propose, only guardian approves)". New drive rules enter `proposed_drive_rules`, and only the guardian can move them to the production `drive_rules` table.

**CANON References:**
- §Core Philosophy 4: "Guardian feedback always outweighs algorithmic evaluation. Guardian confirmation weight: 2x. Guardian correction weight: 3x. The guardian is ground truth for real-world relevance."
- §Immutable Standard 5 (Guardian Asymmetry): "Guardian feedback always outweighs algorithmic evaluation. Confirmations = 2x weight. Corrections = 3x weight."
- §Drive Isolation: "The system can PROPOSE new rules, but they enter a review queue — they do not self-activate."

**Analysis:**

**COMPLIANT** — E4 enforces guardian primacy through process and database architecture:

- ✓ **Proposal mechanism:** IRuleProposer.proposeRule() INSERTs into `proposed_drive_rules` (PostgreSQL)
- ✓ **No auto-activation:** Proposed rules do not activate — they sit in a queue
- ✓ **Guardian review:** The guardian (Jim) inspects the queue and explicitly moves approved rules to `drive_rules`
- ✓ **Database enforcement:** PostgreSQL RLS prevents the app from writing directly to `drive_rules`
- ✓ **Guardian Asymmetry application (partial):** 2x/3x multipliers must be applied when guardian confirms/corrects. E4 must include this in the confidence weight calculation

**Gap for E4 implementation:** Where exactly do the 2x/3x Guardian Asymmetry multipliers apply? The CANON specifies them as weights on "confirmation" and "correction" events. In E4's context, these would be:

- **Guardian confirmation:** When Jim confirms a proposed rule or approves a planned procedure, the confidence impact is 2x what it would be algorithmically
- **Guardian correction:** When Jim corrects Sylphie's action or drive assessment, the impact is 3x

**Recommendation:** E4 should document the exact integration point. Does Guardian Asymmetry apply to:
1. Confidence updates for edges the guardian corrects? (YES — Learning integrates this in E7)
2. Drive rule approval weights? (PARTIAL — needs specification)
3. Rule proposal acceptance/rejection signals back to the Drive Engine? (NEEDS CLARIFICATION)

**Decision required for Jim:** How should the 2x/3x Guardian Asymmetry multipliers integrate with E4's opportunity detection and rule proposal mechanisms?

**Status:** COMPLIANT WITH CONCERNS.

---

### 1.6 Personality Emerges from Contingencies (CANON §Core Philosophy 5)

**Specification:**
E4 delivers "All 5 behavioral contingencies from CANON":
1. Satisfaction Habituation Curve
2. Anxiety Amplification
3. Guilt Repair Contingency
4. Social Comment Quality
5. Curiosity Information Gain

**CANON References:**
- §Core Philosophy 5: "Personality emerges from contingencies, not targets... There is no personality target. There are behavioral contingencies that, if well-designed, produce a companion worth interacting with."
- §Behavioral Contingency Structure: Detailed specifications for each of the 5 contingencies
- §Known Attractor States: "Depressive Attractor" (KG(Self) negative assessment loops)

**Analysis:**

**COMPLIANT WITH CLARITY NEEDED** — E4 specifies all 5 contingencies but leaves implementation details to CANON gaps:

- ✓ **Satisfaction Habituation:** Repeated success → diminishing relief (+0.20, +0.15, +0.10, +0.05, +0.02)
- ✓ **Anxiety Amplification:** High anxiety (>0.7) + negative outcome → 1.5x confidence reduction
- ✓ **Guilt Repair:** Requires BOTH acknowledgment AND behavioral change for full relief
- ✓ **Social Comment Quality:** Guardian response within 30s → extra reinforcement
- ✓ **Curiosity Information Gain:** Relief proportional to actual new knowledge gained

**Implementation challenges (gaps that block E4 code):**

1. **Satisfaction Habituation** requires tracking consecutive successes for the same action. E4 must query TimescaleDB for action frequency and success patterns.
2. **Anxiety Amplification** requires the exact anxiety threshold (>0.7) to be specified and the confidence reduction formula (1.5x how much? Of what base?).
3. **Guilt Repair** requires detecting both acknowledgment (what counts as acknowledgment?) and behavioral change (what constitutes change?).
4. **Social Comment Quality** requires detecting guardian response timing. Where does this happen? Communication (E6) must timestamp Sylphie-initiated comments and log guardian responses. Drive Engine must read these.
5. **Curiosity Information Gain** requires metrics for "new knowledge gained" — node count? Confidence increase? Both?

**CANON Gap:** These are detailed in CANON appendix A.15 (Full Behavioral Contingency Tables), which is reserved. E4 cannot implement until A.15 is specified.

**Status:** COMPLIANT WITH CLARITY NEEDED (gaps in CANON A.15).

---

### 1.7 Prediction Drives Learning (CANON §Core Philosophy 6)

**Specification:**
E4 states: "Prediction accuracy evaluation" and "Inaccurate predictions → Opportunity Evaluation → Create Opportunity". This creates the signal for Planning to generate new procedures.

**CANON References:**
- §Core Philosophy 6: "Sylphie makes predictions... Failed predictions are the primary catalyst for growth."
- §Subsystem 4 (Drive Engine): "Evaluate Prediction Accuracy from Decision Making... Inaccurate predictions → Opportunity Evaluation"
- §Known Attractor States / Prediction Pessimist: "Early failures flood the system with low-quality procedures before the graph has substance. Prevention: Cold-start dampening — early prediction failures have reduced Opportunity generation weight."

**Analysis:**

**COMPLIANT** — E4 implements the prediction-driven learning signal:

- ✓ Drive Engine evaluates prediction accuracy from Decision Making
- ✓ Prediction failures generate Opportunities
- ✓ Opportunities are classified (recurring vs. high-impact vs. low-priority)
- ✓ Opportunities feed to Planning (E8) which creates new procedures
- ✓ Procedures (if executed successfully) are used again, building Type 1 reflexes
- ✓ Failed predictions in high-cognitive-load situations automatically trigger Cognitive Awareness drive increase, which triggers Learning maintenance cycles

**Cold-Start Dampening (Attractor Prevention):**
E4 roadmap mentions this is necessary but does not detail the mechanism. The CANON specifies: "early prediction failures have reduced Opportunity generation weight". This means:

- Opportunity detection during session 1-3 should generate Opportunities with lower priority/weight
- This prevents creating a backlog of untested procedures before the graph has substance

**Gap:** E4 must specify when "cold-start dampening" ends. Is it:
- After N sessions? (e.g., 10 sessions)
- After cumulative experience threshold? (e.g., 500 events)
- After prediction accuracy stabilizes?

**Decision required for Jim:** Specify cold-start dampening duration in CANON A.10 (Attractor State Catalog).

**Status:** COMPLIANT WITH CLARITY NEEDED.

---

### 1.8 Provenance Is Sacred (CANON §Core Philosophy 7)

**Specification:**
E4 roadmap does not explicitly mention provenance tracking for drive events. However, all events written to TimescaleDB (E2) must carry provenance.

**CANON References:**
- §Core Philosophy 7: "Every node and edge in the WKG carries a provenance tag. This enables the lesion test."
- §Subsystem 4: "Tick Event → query last 10 event frequencies from TimescaleDB"
- §Development Metrics: "Experiential provenance ratio... increasing over time" is a health metric

**Analysis:**

**COMPLIANT** — E4 correctly integrates with TimescaleDB provenance:

- ✓ All drive events (DRIVE_TICK, OPPORTUNITY_CREATED, DRIVE_EVENT, HEALTH_STATUS) written to TimescaleDB carry subsystem metadata
- ✓ E2 (Events module) enforces provenance on all writes
- ✓ Drive Engine as subsystem is one of the event sources (SUBSYSTEM_SOURCE in E0 types)
- ✓ Lesion test remains valid: if you remove LLM, Drive Engine behavior is still traceable through SENSOR + GUARDIAN + INFERENCE events (not LLM_GENERATED)

**Strength:** The LLM does not influence drive computation directly. Drive decisions are based on event frequencies and prediction accuracy, both of which are recorded with full provenance in TimescaleDB.

**Status:** COMPLIANT.

---

## 2. Six Immutable Standards Check

### 2.1 Theater Prohibition (CANON §Immutable Standard 1)

**Specification:**
E4 specifies: "Theater Prohibition enforcement (zero reinforcement for theatrical output)". The CANON states: "If Sylphie produces an emotional expression and the corresponding drive is below 0.2, the expression receives zero reinforcement regardless of guardian response."

**CANON Text:**
"Any output (speech, motor action, reported state) must correlate with actual drive state. If Sylphie produces an emotional expression and the corresponding drive is below 0.2, the expression receives zero reinforcement regardless of guardian response. The system cannot learn to perform emotions it does not have."

**Analysis:**

**COMPLIANT WITH CRITICAL CLARIFICATION NEEDED** — The enforcement boundary is clear in concept but requires specification:

**What E4 must do:**
- ✓ Track drive snapshots at the moment of action selection
- ✓ When Decision Making executes an action that expresses an emotional state (e.g., "I'm curious" action when Curiosity < 0.2)
- ✓ Flag this in the action outcome event as `theatrical: true`
- ✓ When this event reaches Drive Engine, apply zero reinforcement (Satisfaction += 0, no drive relief)

**What E6 (Communication) must do (from Theater Prohibition requirement):**
- Receive drive snapshot from Drive Engine
- Inject drive values into LLM context ("You are feeling: Curiosity=0.05, Anxiety=0.8, ...")
- When response is generated, check if emotional markers (I'm curious, I feel happy, I want to explore) correlate with actual drive values
- If not, flag as theatrical before execution

**Critical gap:** The roadmap assigns "Theater Prohibition enforcement" to E4 (Drive Engine), but the correlation check must happen in E6 (Communication) BEFORE the action is executed. Otherwise, by the time E4 sees it, it's too late to prevent the expression — E4 can only withhold reinforcement after-the-fact.

**Split responsibility model (required for correct implementation):**
1. **E6 (Communication):** Pre-flight check — does this response correlate with current drive state? If not, don't execute it (or flag for guardian approval).
2. **E4 (Drive Engine):** Post-action enforcement — if an action was executed despite low drive, apply zero reinforcement.

**Recommendation:** E4 roadmap should clarify:
- Does E4 enforce theater prohibition, or does E6?
- Or does E4 provide the "zero reinforcement rule" and E6 provides the "pre-flight check"?

**Suggested split (aligned with architecture):**
- **E4 (Drive Engine):** Defines theater enforcement as zero reinforcement for actions expressing drives < 0.2
- **E6 (Communication):** Implements pre-flight validation using drive snapshot from E4
- **E5 (Decision Making):** Uses theater-flagged outcomes to learn NOT to select that action again

**Decision required for Jim:** Should the Theater Prohibition be enforced:
1. Pre-flight (E6 prevents theatrical responses before execution)?
2. Post-flight (E4 withholds reinforcement)?
3. Both (E6 prevents, E4 backstops)?

**Current status:** COMPLIANT WITH CRITICAL CONCERNS.

---

### 2.2 Contingency Requirement (CANON §Immutable Standard 2)

**Specification:**
E4 states: "All 5 behavioral contingencies from CANON" and "Drive relief assignment formulas are fixed". Every reinforcement must trace to a specific action.

**CANON Text:**
"Every positive reinforcement event must trace to a specific behavior. No non-contingent reinforcement. Pressure changes without a corresponding action are environmental events, not learning signals."

**Analysis:**

**COMPLIANT** — E4 enforces strict behavioral contingency:

- ✓ Every drive relief is triggered by an IPC message from the app: `ACTION_OUTCOME` with action ID
- ✓ Drive relief formulas look up the action in the event stream
- ✓ Environmental events (time passing, guardian arriving) are explicitly excluded from drive relief
- ✓ Behavioral contingencies (satisfaction, guilt, curiosity) all require a specific action to have occurred
- ✓ Self-evaluation from KG(Self) reads stored self-assessments but does not generate drive relief — it adjusts baselines for the next tick

**Non-contingent reinforcement prevention:**
- ✓ No ambient Satisfaction increase for "the session is going well"
- ✓ No automatic drive decay to "rest" states — drives maintain state unless a contingency applies
- ✓ Guardian feedback (E6 integration) must be tied to a specific action (what did Sylphie do that the guardian is responding to?)

**Architectural guarantee:** The IPC message structure enforces this. Every ACTION_OUTCOME includes:
- action_id (references specific procedure)
- outcome_type (success, partial, failure)
- timestamp
- context (drive state, WKG state, prediction)

Without this message, no reinforcement occurs.

**Status:** COMPLIANT.

---

### 2.3 Confidence Ceiling (CANON §Immutable Standard 3)

**Specification:**
E4 roadmap states: "Confidence dynamics (ACT-R formula)" and "retrieval threshold: 0.50; Type 1 graduation: confidence > 0.80 AND MAE < 0.10".

**CANON Text:**
"No knowledge exceeds 0.60 confidence without at least one successful retrieval-and-use event. Knowing something is not enough — you have to use it and succeed."

**Analysis:**

**COMPLIANT** — E4 integrates the confidence ceiling through the graduation mechanism:

- ✓ Confidence calculation starts at provenance base (SENSOR: 0.40, GUARDIAN: 0.60, LLM_GENERATED: 0.35, INFERENCE: 0.30)
- ✓ Retrieval threshold: 0.50 — actions below this are not selected
- ✓ Type 1 graduation: confidence > 0.80 — this is ABOVE the ceiling of 0.60
- ✓ To reach > 0.80, a behavior must be retrieved-and-used successfully at least 10 times (via ACT-R formula)
- ✓ E5 (Decision Making) uses this: only high-confidence candidates (>0.80) can win arbitration and become Type 1

**Ceiling enforcement location:**
- **E3 (Knowledge):** Enforces ceiling on graph nodes at upsertNode time
- **E5 (Decision Making):** Respects ceiling when retrieving action candidates
- **E4 (Drive Engine):** Evaluates prediction accuracy, feeding the confidence update signal

**The ceiling prevents premature Type 1 graduation:**
- A newly learned action (created by Planning E8 with LLM_GENERATED base 0.35) cannot immediately become Type 1
- It must be used successfully multiple times to accumulate confidence evidence
- This prevents the system from seizing on untested LLM suggestions

**Status:** COMPLIANT.

---

### 2.4 Shrug Imperative (CANON §Immutable Standard 4)

**Specification:**
E4 roadmap does not explicitly mention the Shrug Imperative, but Decision Making (E5) must implement it: "Shrug Imperative: when nothing above threshold, signal incomprehension".

**CANON Text:**
"When nothing is above the dynamic action threshold, Sylphie signals incomprehension rather than selecting a random low-confidence action. Honest ignorance prevents superstitious behavior."

**Analysis:**

**COMPLIANT WITH CLARIFICATION NEEDED** — E4 provides the confidence signal that enables E5 to implement Shrug:

- ✓ Drive Engine computes prediction accuracy and confidence updates
- ✓ These confidence values flow to Decision Making via the shared graph and IPC messages
- ✓ Decision Making (E5) will receive confidence signals that enable Shrug logic
- ✓ E4 is not responsible for implementing Shrug — E5 (Decision Making) is

**Gap for E4 clarity:** E4 must specify what "dynamic action threshold" is. The CANON states it is "dynamic and bidirectional — modulated by drive state". This means:

- When System Health drive is high, threshold might be lower (accept lower-confidence actions to maintain stability)
- When Anxiety is high, threshold might be higher (only very confident actions in uncertain times)
- When Boredom is high, threshold might be lower (explore novelty despite low confidence)

**Current specification:** E4 does not detail the threshold modulation formula. This is likely in CANON A.3 (Arbitration Algorithm, reserved).

**Recommendation:** E4 and E5 must coordinate on this threshold. E4 should output the "current threshold" as part of each drive snapshot, and E5 should use it.

**Status:** COMPLIANT WITH CLARITY NEEDED.

---

### 2.5 Guardian Asymmetry (CANON §Immutable Standard 5)

**Specification:**
E4 specifies "Guardian Asymmetry (2x confirm, 3x correction)" but does not detail where these multipliers apply in the drive computation.

**CANON Text:**
"Guardian feedback always outweighs algorithmic evaluation. Confirmations = 2x weight. Corrections = 3x weight. The guardian is ground truth for real-world relevance."

**Analysis:**

**COMPLIANT WITH CRITICAL GAPS** — The concept is recognized but implementation integration is unclear:

- ✓ E4 acknowledges Guardian Asymmetry as a constraint
- ✓ PostgreSQL design (E1) enforces guardian control over drive rules
- ✓ Rule proposal queue (E4) ensures guardian final authority
- ✓ IPC messages flow from app to Drive Engine, enabling the guardian's real-time influence

**Where Guardian Asymmetry applies (NEEDS SPECIFICATION):**

1. **Drive rule acceptance:** When guardian approves a proposed drive rule, the rule's effect is weighted 2x or 3x?
   - Current spec: Rules go to `proposed_drive_rules`, guardian moves them to `drive_rules`. No explicit weight.
   - **Gap:** Is this just a binary decision (approve/reject)? Or does the guardian assign a weight?

2. **Confidence update from guardian feedback:** When guardian corrects an action (E6), how does the 3x correction weight apply?
   - This happens in Learning (E7) and Knowledge (E3), not Drive Engine
   - But Drive Engine should read the result: confidence updates with 3x weight applied
   - **Gap:** Is E4 responsible for applying guardian asymmetry, or just reading it?

3. **Opportunity weighting:** When guardian confirms an Opportunity is real (vs. system-generated false positive), should that Opportunity have 2x priority?
   - **Gap:** Not specified

4. **Drive baseline adjustment:** When guardian confirms Sylphie's self-assessment (e.g., "Yes, you are good at X"), should that adjust drive baselines with 2x weight?
   - Happens during self-evaluation (E4 reads KG(Self))
   - **Gap:** Not specified

**Architectural principle (from CANON):**
The 2x/3x asymmetry is a coefficient on confidence/weight calculations. It should appear in:
- ACT-R confidence formula (when guardian confirms/corrects, multiply the impact by 2x or 3x)
- Opportunity priority scoring (when guardian confirms, increase priority by 2x)
- Drive baseline adjustments (when guardian confirms self-assessment, weight it 2x)

**Recommendation:** E4 should explicitly define where Guardian Asymmetry appears:

```typescript
// Example: Drive rule approval from guardian
const ruleWeight = isGuardianCorrection ? 3.0 : 1.0;
const ruleWeight = isGuardianConfirmation ? 2.0 : 1.0;
applyDriveRule(rule, ruleWeight);
```

**Decision required for Jim:** Specify Guardian Asymmetry application in E4 context:
1. Does it apply to rule weights, confidence updates, or both?
2. Is there a single Guardian Asymmetry weight (2x/3x), or does the weight vary by situation?
3. Should opportunity priority be affected by guardian confirmation?

**Current status:** COMPLIANT WITH CRITICAL CONCERNS.

---

### 2.6 No Self-Modification of Evaluation (CANON §Immutable Standard 6)

**Specification:**
E4 states: "One-way enforcement: structural (no write methods on exported interface), process-level (separate process), database-level (PostgreSQL RLS)".

**CANON Text:**
"Sylphie can learn WHAT to do, HOW effective each action is, and WHEN to do it. She cannot learn to modify HOW success is measured — the evaluation function is fixed architecture."

**Analysis:**

**COMPLIANT** — E4 implements the most rigorous version of this standard:

**Triple enforcement:**

1. **Process-level isolation (strongest):**
   - Drive Engine runs in `child_process.fork()` separate process
   - Evaluation function (drive ticks, contingency application, prediction MAE computation) lives in the child process
   - Main process cannot directly call evaluation functions
   - ✓ Prevents app-level attempts to modify how success is measured

2. **Database-level isolation (medium strength):**
   - PostgreSQL RLS: `sylphie_app` role can SELECT from `drive_rules` only
   - No UPDATE/DELETE/ALTER on `drive_rules`
   - No direct write to the evaluation function's rule set
   - ✓ Prevents database-level rule manipulation

3. **Interface-level isolation (weakest but important):**
   - Exported interface: `IDriveStateReader` (read-only) and `IActionOutcomeReporter` (fire-and-forget)
   - No methods like `setConfidenceMultiplier()`, `modifyDriveRule()`, `changeEvaluationFunction()`
   - ✓ Prevents accidental or malicious API calls to modify evaluation

**What the app CAN do:**
- Read drive state (via DRIVE_SNAPSHOT IPC messages)
- Report action outcomes (via ACTION_OUTCOME IPC messages)
- Propose new drive rules (INSERT into `proposed_drive_rules`)

**What the app CANNOT do:**
- Modify how success is measured (evaluation function is untouchable)
- Change drive relief formulas
- Update prediction error computation
- Access or modify the confidence update logic
- Approve its own proposed rules (only guardian can)

**Architectural guarantee:** The three-layer isolation is redundant (good). If any one layer fails, the other two still protect the evaluation function.

**Risk analysis:**
- **Highest risk:** A vulnerability in the child_process.fork() communication protocol could allow arbitrary code execution in the child process
- **Medium risk:** A SQL injection in PostgreSQL rule lookup could lead to rule modification
- **Lowest risk:** Interface-level protection (easy to bypass with direct imports, but the above layers catch it)

**Recommendation:** E4 should document the threat model and explain which layer each threat is blocked by.

**Status:** COMPLIANT.

---

## 3. Architecture Compliance

### 3.1 Five Subsystems: Drive Engine Role

**Specification:**
Drive Engine (Subsystem 4) is positioned correctly in the roadmap and connected to the other subsystems.

**CANON References:**
- §Subsystem 4 (Drive Engine): Full specification
- §Five Subsystems overview: Position in the cognitive architecture

**Analysis:**

**COMPLIANT** — E4 correctly implements Drive Engine as the evaluation and motivation system:

**Inputs (reads from):**
- ✓ TimescaleDB: event frequencies, prediction outcomes
- ✓ KG(Self): self-model for slower-timescale self-evaluation
- ✓ PostgreSQL: drive rules for rule lookup
- ✓ IPC from app: ACTION_OUTCOME, SESSION_START/END, SOFTWARE_METRICS

**Outputs (writes to):**
- ✓ TimescaleDB: DRIVE_TICK events, OPPORTUNITY_CREATED events, DRIVE_EVENT events, HEALTH_STATUS
- ✓ IPC to app: DRIVE_SNAPSHOT (drive values), OPPORTUNITY_CREATED, DRIVE_EVENT, HEALTH_STATUS

**Integration points:**
- ✓ Decision Making (E5): reads drive snapshots to modulate confidence thresholds
- ✓ Communication (E6): reads drive snapshots to inject into LLM context
- ✓ Learning (E7): reads opportunities to trigger maintenance cycles
- ✓ Planning (E8): reads opportunities to generate new procedures

**Non-dependencies:**
- ✗ Drive Engine does NOT write to WKG (correct — that's Learning's job)
- ✗ Drive Engine does NOT call the LLM (correct — that's Communication's job)
- ✗ Drive Engine does NOT modify action selection (correct — that's Decision Making's job)

**Status:** COMPLIANT.

---

### 3.2 Five Databases: Drive Engine Integration

**Specification:**
E4 integrates with all three databases required for its function: TimescaleDB, PostgreSQL, and Grafeo (for Self KG reads).

**CANON References:**
- §Five Databases (Shared Infrastructure)
- §Subsystem 4 (Drive Engine): "Rule Lookup in Postgres → if found, Affect Drives"

**Analysis:**

**COMPLIANT** — E4 respects the database boundaries:

| Database | Role | E4 Usage |
|----------|------|---------|
| **TimescaleDB** | Event backbone | ✓ Read event frequencies for rule lookup; read prediction outcomes for MAE |
| **PostgreSQL** | Drive rules + meta | ✓ SELECT only on `drive_rules` table; INSERT only on `proposed_drive_rules` |
| **Grafeo (Self KG)** | Self-model | ✓ Read KG(Self) for self-evaluation on slower timescale |
| **Neo4j (WKG)** | World knowledge | ✓ Not accessed by Drive Engine (correct — only Learning writes, others read) |

**Isolation maintained:**
- ✓ Drive Engine does NOT write to WKG
- ✓ Drive Engine does NOT read from Other KGs (person models)
- ✓ Drive Engine does NOT write to TimescaleDB event types outside its subsystem scope

**Status:** COMPLIANT.

---

### 3.3 KG Isolation: Drive Engine's Role

**Specification:**
Drive Engine reads KG(Self) but does not write to it. The three KGs remain isolated.

**CANON References:**
- §KG Isolation: "Self KG, Other KG, and WKG never share edges"
- §Subsystem 4: "Self Evaluation → query KG(Self)"

**Analysis:**

**COMPLIANT** — E4 respects KG isolation:

- ✓ Drive Engine reads Self KG (Grafeo instance) on a slower timescale
- ✓ Drive Engine does NOT write to Self KG
- ✓ Drive Engine does NOT read from Other KGs (person models are Communication's responsibility)
- ✓ Drive Engine does NOT access WKG
- ✓ The three KGs remain completely isolated

**Data flow guarantee:**
- Experience → Learning (E7) → writes to KG(Self) and WKG
- KG(Self) → Drive Engine (E4) reads → adjusts drive baselines
- No backward flow (Drive Engine cannot modify KG(Self))

**Status:** COMPLIANT.

---

### 3.4 Drive Isolation (CRITICAL)

**Specification:**
E4 implements the most critical architectural constraint: "Separate process with one-way communication. The system can READ drive values but cannot WRITE to the evaluation function."

**CANON References:**
- §Drive Isolation: Full section
- §Immutable Standard 6: "The evaluation function is fixed architecture."

**Analysis:**

**COMPLIANT** — E4 implements Drive Isolation correctly through three independent layers:

**Layer 1: Process Isolation (Structural)**
- ✓ Child process spawned with `child_process.fork('src/drive-engine/drive-process/index.ts')`
- ✓ Evaluation logic runs entirely in child process memory space
- ✓ Main process cannot directly execute evaluation functions
- ✓ Communication is IPC-only (message passing, no shared memory modification)

**Layer 2: IPC Protocol (Behavioral)**
- ✓ Inbound messages: ACTION_OUTCOME, SOFTWARE_METRICS, SESSION_START/END (telemetry, no evaluation modification)
- ✓ Outbound messages: DRIVE_SNAPSHOT, OPPORTUNITY_CREATED, DRIVE_EVENT, HEALTH_STATUS (read-only reports)
- ✓ No IPC message type allows writing to evaluation function
- ✓ One-way communication enforced by message type enums

**Layer 3: Database Isolation (Structural)**
- ✓ PostgreSQL RLS: `sylphie_app` role has SELECT on `drive_rules`, no write
- ✓ Proposed rules enter `proposed_drive_rules`, not `drive_rules`
- ✓ Only guardian (different PostgreSQL role) can move rules from proposed → production
- ✓ Even if child process tried to write (shouldn't, but defensive), PostgreSQL prevents it

**Threat model coverage:**
- **Threat:** App tries to modify evaluation function directly → **Mitigated by:** Process isolation (can't call child functions) + Database RLS (can't modify rules)
- **Threat:** App tries to call evaluation function via IPC → **Mitigated by:** IPC protocol (no write message types)
- **Threat:** Rule injection via proposed_drive_rules → **Mitigated by:** Guardian approval gate (only guardian can activate rules)
- **Threat:** Child process corrupted by app → **Mitigated by:** Separate process (child isolation from app memory)

**Strength:** This is the most rigorously enforced boundary in the architecture. The evaluation function is protected by multiple independent mechanisms.

**Status:** COMPLIANT.

---

### 3.5 Subsystem Communication: Drive Engine's Boundaries

**Specification:**
Drive Engine communicates with other subsystems only through TimescaleDB and IPC, never through direct function calls or shared state.

**CANON References:**
- §Shared Infrastructure: "Subsystems communicate through shared stores, not direct internal access"

**Analysis:**

**COMPLIANT** — E4 enforces subsystem boundaries:

**Allowed communication:**
- ✓ Reads from TimescaleDB (all subsystems write here, Drive Engine reads event frequencies)
- ✓ Reads from PostgreSQL (drive rules — read-only)
- ✓ Reads from Grafeo Self KG (self-model data)
- ✓ IPC with app (one-way: receives ACTION_OUTCOME, sends DRIVE_SNAPSHOT)

**Forbidden communication:**
- ✗ No direct imports of other subsystem services
- ✗ No shared state with Decision Making (only through TimescaleDB/IPC)
- ✗ No direct calls to Learning or Planning
- ✗ No circular dependencies

**Module boundaries (from E0 architecture):**
Each subsystem has a module with DI tokens. Drive Engine module exports:
- `DRIVE_STATE_READER` token (interface, not implementation)
- `ACTION_OUTCOME_REPORTER` token (interface, not implementation)
- `RULE_PROPOSER` token (interface, not implementation)

Other modules inject these tokens, never instantiate Drive Engine directly.

**Status:** COMPLIANT.

---

## 4. Phase Boundary Check

**Specification:**
E4 is Phase 1 work (The Complete System), not Phase 2 (The Body — robot chassis).

**CANON References:**
- §Implementation Phases: Phase 1 vs. Phase 2 scope

**Analysis:**

**COMPLIANT** — E4 stays within Phase 1:

- ✓ No hardware interfaces
- ✓ No motor control
- ✓ No physical sensors
- ✓ No robot chassis integration
- ✓ Drive Engine is a logical subsystem, not hardware-mediated
- ✓ Separate process is Node.js, not hardware isolation

**What E4 IS:**
- Process-based computation of motivational state
- Rule-based evaluation of actions
- Opportunity detection from prediction failures
- Behavioral contingency implementation

**What E4 ISN'T:**
- Hardware-dependent (robot sensors, motor feedback)
- Embodied (physical space exploration)
- Multi-body (communication with other Sylphie instances)

**Status:** COMPLIANT.

---

## 5. Confidence Dynamics Check

**Specification:**
E4 integrates with ACT-R confidence formula and Type 1/Type 2 graduation.

**CANON References:**
- §Confidence Dynamics (ACT-R): Formula and thresholds
- §Type 1 / Type 2 Graduation: confidence > 0.80 AND MAE < 0.10 over last 10 uses

**Analysis:**

**COMPLIANT WITH CLARITY NEEDED** — E4 provides the prediction accuracy signal that enables Type 1/Type 2 decisions:

**What E4 must compute:**
- ✓ MAE (mean absolute error) for each action over last 10 uses
- ✓ Prediction outcome (success/partial/failure) for confidence updates
- ✓ Confidence decay based on time since last use

**What E4 provides:**
- ✓ DRIVE_SNAPSHOT messages with current drive state (used to modulate arbitration threshold)
- ✓ OPPORTUNITY_CREATED messages when predictions fail (feeds Planning and Learning)
- ✓ MAE data in events (flows to Decision Making for arbitration)

**Gap: Where exactly is MAE calculated and stored?**
- E4 computes MAE from prediction outcomes in TimescaleDB
- E4 sends MAE as part of OPPORTUNITY_CREATED or DRIVE_EVENT messages
- E5 (Decision Making) receives MAE and uses it for arbitration threshold
- **Question:** Does E4 also write MAE back to the action node in WKG so it persists? Or is it only in events?

**Recommendation:** E4 should clarify the MAE persistence model:
1. MAE computed in E4 from TimescaleDB query (ephemeral, current session)
2. MAE reported to Decision Making via IPC (used for arbitration)
3. MAE stored in WKG action node confidence calculation (persistent, for next session)

The ACT-R formula uses `ln(count)` (retrieval count), which is incremented on successful use. E5 (Decision Making) must update this count after each action, and E3 (Knowledge) must enforce the `recordRetrievalAndUse()` call.

**Status:** COMPLIANT WITH CLARITY NEEDED.

---

## 6. Behavioral Contingency Implementation

**Specification:**
E4 delivers "All 5 behavioral contingencies from CANON" with specific parameters.

**CANON References:**
- §Behavioral Contingency Structure: Detailed specifications
- §CANON Appendix A.15: Full Behavioral Contingency Tables (reserved)

**Analysis:**

**COMPLIANT WITH CRITICAL GAPS** — All 5 contingencies are recognized, but implementation details require CANON A.15:

| Contingency | Status | Gap |
|-------------|--------|-----|
| **Satisfaction Habituation** | Specified | Needs exact implementation: track consecutive successes per action, apply diminishing curve |
| **Anxiety Amplification** | Specified | Needs threshold (>0.7?) and formula (1.5x what exactly?) |
| **Guilt Repair** | Specified | Needs detection of "acknowledgment" and "behavioral change" |
| **Social Comment Quality** | Specified | Timing (30s window) and detection mechanism (E6 integration) |
| **Curiosity Information Gain** | Specified | Metric for "new knowledge" (nodes? confidence increase? entropy?) |

**Each contingency requires:**

1. **Event recognition:** Drive Engine must detect when the contingency applies
2. **Computation:** Calculate the drive relief amount
3. **Application:** Apply relief to the correct drive
4. **Logging:** Record in TimescaleDB for learning feedback

**Example (Satisfaction Habituation):**
```
1. App sends ACTION_OUTCOME (action_id: "play_music", outcome: "success")
2. Drive Engine looks up action in WKG: "play_music" (confidence 0.85, last_exec_time: 30min ago)
3. Counts consecutive successes: 1st today, 2nd yesterday, 3rd two days ago (counts as different session)
4. Applies habituation curve: 1st success in session → +0.20 Satisfaction
5. Logs: DRIVE_EVENT(satisfaction_delta: 0.20, contingency: "satisfaction_habituation_first", action_id: "play_music")
```

**Gap for Satisfaction Habituation:** What constitutes "consecutive"? Same action in same session? Same category of actions? Does a day boundary reset the count?

**Gap for Anxiety Amplification:** When Action X is executed under high Anxiety (say, 0.8) and outcome is negative (failure), apply 1.5x confidence reduction. Where is this confidence reduction applied?
- On the action's confidence in WKG? (yes, Learning E7 does this)
- On the rule that selected this action? (yes, if it's a derived rule, E7 updates it)
- On the drive rule that shaped the decision? (maybe — this would be rule-level learning)

**Decision required for Jim:** Expand CANON A.15 (Full Behavioral Contingency Tables) with:
1. Exact parameters for each contingency
2. Implementation algorithm
3. Database schema for tracking (e.g., action success streak table)
4. Logging format for auditing

**Status:** COMPLIANT WITH CRITICAL GAPS.

---

## 7. Planning Rules Check

**Specification:**
E4 is preceded by epic planning (CANON states: "No code without epic-level planning").

**CANON References:**
- §Planning & Implementation Rules: "No code without epic-level planning validated against this CANON"
- §Roadmap / Epic 4: Full specification of deliverables

**Analysis:**

**COMPLIANT** — E4 roadmap provides clear planning:

- ✓ Epic 4 dependencies specified (E0, E1, E2)
- ✓ Deliverables enumerated in detail
- ✓ v1 sources identified for code lift
- ✓ Key risks flagged (Grafeo maturity, separate process complexity)

**Tangible artifacts (per CANON):**
- ✓ Separate process with 100Hz tick loop
- ✓ 12-drive computation with specified parameters
- ✓ Behavioral contingencies (5)
- ✓ Opportunity detection algorithm
- ✓ IPC protocol (typed messages)

**Session context preservation:**
- ✓ Agent analyses (this document) capture design decisions
- ✓ Roadmap documents dependencies for next sessions

**Status:** COMPLIANT.

---

## 8. CANON Gaps and Decisions Requiring Jim

### Gap 1: CANON A.1 — Detailed Drive Cross-Modulation Rules

**Specification Location:** CANON §Appendix A.1 (reserved)

**What it affects:** E4 implementation of drive interdependencies

**Current state:** The roadmap mentions "core drives → complement drives → cross-modulation → clamping" but does not specify the cross-modulation rules in detail.

**What's needed:**
- How do core drives (System Health, Moral Valence, Integrity, Cognitive Awareness) influence complement drives?
- What is the cross-modulation matrix?
- What are the clamping bounds for each drive?
- Are cross-modulation rules static or adaptive?

**Impact on E4:** Without this, the drive tick loop cannot be implemented correctly.

**Decision required:** Jim specifies A.1 before E4 implementation begins.

---

### Gap 2: CANON A.4 — Opportunity Detection and Classification Criteria

**Specification Location:** CANON §Appendix A.4 (reserved)

**What it affects:** E4's opportunity detection algorithm

**Current state:** Roadmap gives general guidance:
- "Recurring patterns → Create Opportunity"
- "Non-recurring but high impact → Create Opportunity"
- "Low impact, non-recurring → Create Potential Opportunity (lower priority)"

**What's needed:**
- Exact definition of "recurring": 3+ in window? 2+ consecutive? Statistical threshold?
- Exact definition of "high impact": magnitude of prediction error > threshold? Affects multiple drives?
- Time window for pattern detection?
- How are Potential Opportunities prioritized relative to Opportunities?

**Impact on E4:** Opportunity detection is the gateway to Planning. Too aggressive (low thresholds) and the system floods with low-quality opportunities (Prediction Pessimist attractor). Too conservative and real patterns are missed.

**Decision required:** Jim specifies A.4 with concrete thresholds before E4 implementation begins.

---

### Gap 3: CANON A.8 — Self-Evaluation Protocol and KG(Self) Schema

**Specification Location:** CANON §Appendix A.8 (reserved)

**What it affects:** E4's self-evaluation on slower timescale

**Current state:** Roadmap mentions "Self-evaluation on slower timescale (reads Self KG)" but does not specify:
- What self-assessments are stored in KG(Self)?
- How often is self-evaluation run (every N ticks? Every N events?)
- How do self-assessments adjust drive baselines?
- What constitutes a valid self-assessment node in KG(Self)?

**Example questions:**
- Node: "Sylphie_Capability_WKGRetrieval" with confidence 0.75 means what?
- Does it adjust System Health baseline? Cognitive Awareness baseline?
- If self-assessed capability > actual success rate, what happens?

**Impact on E4:** Self-evaluation is the mechanism that prevents the Depressive Attractor. Without clear schema, E4 cannot implement it.

**Decision required:** Jim specifies A.8 with KG(Self) schema and baseline adjustment algorithm before E4 implementation begins.

---

### Gap 4: CANON A.14 — Drive Accumulator Rates and Decay Parameters

**Specification Location:** CANON §Appendix A.14 (reserved)

**What it affects:** E4's drive tick loop computation

**Current state:** The confidence dynamics formula is specified (ACT-R), but drive accumulation is not:
- What is the base rate for each drive tick? (e.g., does Anxiety increase by 0.01 per tick by default?)
- What is the decay rate? (how fast does Satisfaction decrease if not reinforced?)
- Are rates constant or state-dependent?
- What are the clamps (min/max) for each drive?

**Impact on E4:** The 100Hz tick loop needs to know exactly how to compute each drive's delta on each tick.

**Decision required:** Jim specifies A.14 with rates, decay, and clamps before E4 implementation begins.

---

### Gap 5: CANON A.15 — Full Behavioral Contingency Tables

**Specification Location:** CANON §Appendix A.15 (reserved)

**What it affects:** Implementation of all 5 behavioral contingencies

**Current state:** CANON §Behavioral Contingency Structure gives high-level specifications. A.15 should expand with full implementation details.

**What's needed for each contingency:**
1. **Satisfaction Habituation**
   - Streak tracking mechanism
   - Exact curve: +0.20, +0.15, +0.10, +0.05, +0.02 — is this per action type or per action instance?
   - Reset condition for streak

2. **Anxiety Amplification**
   - Threshold: exactly 0.7 or range (0.6-0.8)?
   - Confidence reduction formula: "1.5x" of what? (1.5x * base_confidence_decrement?)
   - Which drives are affected?

3. **Guilt Repair**
   - Acknowledgment detection: what counts? (verbal "I'm sorry"? Specific action? No interference for 10 ticks?)
   - Behavioral change detection: what counts? (different action next time? Correction applied to WKG edge?)
   - Partial relief: -0.10 for acknowledgment alone, -0.15 for change alone, -0.30 for both?

4. **Social Comment Quality**
   - Timer: exactly 30s or range?
   - Detection: Communication must log Sylphie-initiated utterances; Drive Engine must read guardian response within window
   - Reinforcement: "Social -0.15 + Satisfaction +0.10" — does this apply to the utterance action only, or to some broader category?

5. **Curiosity Information Gain**
   - Metric: new nodes created? Confidence increases? Entropy decrease? Combination?
   - Quantification: Curiosity relief proportional to gain amount (e.g., Curiosity -= 0.01 * (new_nodes + confidence_delta))?
   - Minimum gain threshold: revisiting known territory gets 0 relief, or diminished relief?

**Impact on E4:** These tables are the implementation spec for behavioral contingencies. Without them, Drive Engine contingency code is guesswork.

**Decision required:** Jim expands CANON A.15 with full contingency tables and formulas before E4 implementation begins.

---

### Gap 6: Theater Prohibition Enforcement Boundary

**Specification Location:** Current roadmap, not explicitly in CANON

**What it affects:** Who enforces that responses correlate with drive state?

**Current state:** Roadmap says "Theater Prohibition enforcement (zero reinforcement for theatrical output)" but does not clarify:
- Does E4 (Drive Engine) enforce, or E6 (Communication)?
- Does E6 pre-flight check prevent theatrical responses?
- Does E4 post-flight enforcement withhold reinforcement?
- What if an action is theatrical? Do we:
  1. Never execute it (E6 prevention)
  2. Execute it but learn not to (E4 withholding)
  3. Execute, learn not to, AND reduce drive state (both)?

**Recommended split responsibility:**
- **E6 (Communication):** Pre-flight check — inject drive state into LLM context and validate response correlation
- **E4 (Drive Engine):** Post-flight enforcement — if a theatrical action was executed, apply zero reinforcement

**Decision required:** Jim clarifies the split responsibility for Theater Prohibition enforcement.

---

### Gap 7: Guardian Asymmetry Application in E4

**Specification Location:** CANON §Immutable Standard 5, not detailed in E4 context

**What it affects:** How are the 2x/3x weights applied?

**Current state:** Guardian Asymmetry is mentioned but not integrated into E4 mechanisms:
- Rule approval: when guardian approves a proposed rule, is the weight 2x? Or is this binary (approve/reject)?
- Confidence updates: when a guardian correction is processed, the 3x weight is applied in E3 (Learning/Knowledge) or E4?
- Opportunity priority: when guardian confirms an Opportunity, does it get 2x priority in Planning's queue?

**Decision required:** Jim clarifies Guardian Asymmetry integration into E4 (or specifies it happens in other epics).

---

## 9. Verdict

### Overall Compliance Status

**COMPLIANT WITH CRITICAL CONCERNS**

### Summary

Epic 4 (Drive Engine) is architecturally sound and respects all eight core philosophy principles and five of the six immutable standards. The drive isolation mechanism is the strongest in the project — enforced at process, database, and interface levels. The behavioral contingency structure is correctly recognized.

However, **five critical CANON gaps (A.1, A.4, A.8, A.14, A.15) block implementation** and must be resolved by Jim before code begins. Additionally, two operational concerns (Theater Prohibition enforcement boundary and Guardian Asymmetry application) require clarification.

### Detailed Verdict Summary

| Category | Status | Evidence |
|----------|--------|----------|
| **Philosophy Alignment** | 8/8 PASS | All principles respected; WKG is brain, LLM is voice, experience drives knowledge, dual-process recognized |
| **Immutable Standard 1** | COMPLIANT WITH CONCERNS | Theater Prohibition recognized but enforcement boundary unclear |
| **Immutable Standard 2** | PASS | Contingency requirement enforced via IPC structure |
| **Immutable Standard 3** | PASS | Confidence ceiling integrated through Type 1 graduation mechanism |
| **Immutable Standard 4** | COMPLIANT WITH CLARITY NEEDED | Shrug imperative is E5 responsibility; E4 provides confidence signal |
| **Immutable Standard 5** | COMPLIANT WITH CRITICAL CONCERNS | Guardian Asymmetry recognized but application integration unclear |
| **Immutable Standard 6** | PASS | No Self-Modification enforced through triple isolation (process, database, interface) |
| **Five Subsystems** | PASS | Drive Engine correctly positioned and bounded |
| **Five Databases** | PASS | All database boundaries respected |
| **KG Isolation** | PASS | Self KG, Other KG, WKG remain isolated |
| **Drive Isolation** | PASS | Strongest enforcement in the project |
| **Phase Boundary** | PASS | No Phase 2 leakage; all work is logical (no hardware) |
| **Behavioral Contingencies** | COMPLIANT WITH CRITICAL GAPS | All 5 recognized; implementation details require A.15 |
| **Planning Rules** | PASS | Epic planning complete, tangible artifacts defined |

### Critical Gaps Blocking Implementation

1. **CANON A.1** — Drive cross-modulation rules (affects drive tick loop)
2. **CANON A.4** — Opportunity detection thresholds (affects Planning trigger)
3. **CANON A.8** — Self-evaluation protocol (affects drive baseline adjustment)
4. **CANON A.14** — Drive accumulator rates (affects tick loop)
5. **CANON A.15** — Behavioral contingency tables (affects all 5 contingencies)

### Design Decisions Requiring Jim Approval

1. **Theater Prohibition Enforcement:** Should E6 prevent or E4 enforce or both?
2. **Guardian Asymmetry in E4:** Where do 2x/3x weights apply in drive computation?
3. **Confidence Ceiling in Type 1 Graduation:** Does MAE persist in WKG or only in events?
4. **Cold-Start Dampening Duration:** When does opportunity dampening end?
5. **Shrug Imperative Dynamic Threshold:** How is threshold modulated by drive state (CANON A.3)?

---

## 10. Required Actions Before Approval

1. **Jim completes CANON A.1, A.4, A.8, A.14, A.15** — All five appendix sections must be specified before E4 implementation
2. **Clarify Theater Prohibition enforcement boundary** — Document which subsystem (E4 or E6) enforces what
3. **Specify Guardian Asymmetry integration** — Document exact application points in E4
4. **Document cold-start dampening duration** — In A.10 (Attractor State Catalog)
5. **Document dynamic threshold modulation** — In A.3 (Arbitration Algorithm) as a reference for E4/E5 coordination

---

## 11. Jim's Attention Needed

### Required Jim Decisions (CANON Appendix Sections)

| Section | Content | Blocking | Recommended Default |
|---------|---------|----------|---------------------|
| **A.1** | Drive cross-modulation rules | E4 | Core drives → complement via learned modulation matrix; clamps at 0.0-1.0 |
| **A.4** | Opportunity detection criteria | E4, E8 | Recurring = 3+ in 100-event window; high-impact = MAE > 0.20 in any drive; else Potential |
| **A.8** | Self-evaluation protocol | E4 | Every 500 ticks, read KG(Self) capability nodes, adjust drive baselines ±0.05 |
| **A.14** | Drive accumulator rates | E4 | Base rate: 0.01/tick; decay: 0.01/tick unless reinforced; clamps: 0.0-1.0 |
| **A.15** | Behavioral contingency tables | E4 | Expand CANON §Behavioral Contingency Structure with exact formulas |

### Operational Clarifications Needed

1. **Theater Prohibition Enforcement:** Pre-flight (E6) or post-flight (E4) or both?
2. **Guardian Asymmetry Application:** Which E4 mechanisms (rule weight, opportunity priority, drive baseline)?
3. **Cold-Start Dampening:** Duration in events, sessions, or calendar time?
4. **Dynamic Threshold:** Formula for drive-state modulation of arbitration threshold?

### Recommendations

**Do not begin E4 implementation until:**
1. Jim approves all five CANON appendix sections (A.1, A.4, A.8, A.14, A.15)
2. Theater Prohibition enforcement boundary is documented
3. Guardian Asymmetry integration is specified
4. Cold-start dampening and dynamic threshold are clarified

The architecture is sound. The gaps are specification, not design.

---

## Signature

**Analyst:** Canon (Project Integrity Guardian)
**Date:** 2026-03-29
**Status:** COMPLIANT WITH CRITICAL CONCERNS
**Recommendation:** Route to Jim for CANON gap resolution before E4 implementation planning.
