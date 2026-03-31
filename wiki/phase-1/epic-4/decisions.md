# Epic 4: Decisions

## Decisions Made During Planning

### 1. Separate Node.js process via child_process.fork()

**Decision:** The Drive Engine runs in a separate Node.js child process spawned from the main NestJS application via `child_process.fork()`. It is not a NestJS service in the main process.

**Rationale (Drive + Forge + Ashby):** Immutable Standard 6 requires that the system cannot modify how success is measured. This is an architectural guarantee, not a code-level promise. The strongest enforcement is process-level isolation: the main process literally cannot have a reference to the evaluation function. Communication is purely via message passing. If the child crashes, the main process degrades gracefully (reads stale drive state). If the main process is compromised, it cannot inject code into the child or alter evaluation logic.

**Trade-off:** Process separation adds operational complexity (crash recovery, health monitoring, IPC serialization overhead). Mitigated by: (a) child_process.fork() is lightweight and built into Node.js (no external dependencies), (b) in Phase 2, this same boundary can support running the Drive Engine on dedicated hardware without code changes.

**Implementation detail:** The child process is spawned on startup and monitored continuously. If it crashes, an exponential backoff retry mechanism respawns it. The main process caches the latest DRIVE_SNAPSHOT and continues operating. After max retries, the system enters safe mode (conservative drive state, guardian alerted).

**CANON alignment:** Immutable Standard 6, Drive Isolation section. This is the primary enforcement mechanism.

### 2. One-way IPC communication (read from child, write to child, no method invocation)

**Decision:** Communication between main process and child process is exclusively via typed message passing. No direct method calls. Main → Child: ACTION_OUTCOME, PREDICTION_RESULT, SESSION_START/END. Child → Main: DRIVE_SNAPSHOT, OPPORTUNITY_CREATED, DRIVE_EVENT, HEALTH_STATUS.

**Rationale (Drive + Forge):** One-way communication prevents the fundamental attack vector of self-modification. If the main process could send methods to the child ("recalculateSatisfactionWeight(2x)"), the drive engine could modify its own evaluation function. Message passing enforces that the main process can only tell the child "here's what happened" and receive back "here's the current drive state." The evaluation function (how to interpret "what happened") is entirely within the child process.

**Trade-off:** No synchronous request-response pattern. The main process sends an ACTION_OUTCOME and waits ~10ms for the next DRIVE_SNAPSHOT to include the updated drives. Latency is acceptable because drive state doesn't need to be real-time for decision-making; eventual consistency (1-2 ticks stale) is sufficient.

**Implementation detail:**
```typescript
// Main process: fire-and-forget
driveProcess.send({ type: 'ACTION_OUTCOME', payload: { actionId, outcome, timestamp } });
// Does NOT wait for response
// Next DRIVE_SNAPSHOT will include updated drives

// Child process: async handling
process.on('message', (msg) => {
  if (msg.type === 'ACTION_OUTCOME') {
    applyOutcome(msg.payload); // Processed on next tick
  }
});
```

**CANON alignment:** Immutable Standard 6, one-way communication requirement.

### 3. Three-layer write protection (structural, process, database)

**Decision:** Write-protection is enforced at three independent levels: (1) TypeScript interface exports only read methods, (2) separate process with no shared memory, (3) PostgreSQL role-based access control prevents app role from modifying drive_rules.

**Rationale (Ashby + Forge + Canon):** Single-layer protection can be circumvented. Three independent layers provide defense in depth. Each layer is strong enough alone; together they are overdetermined. Breaching one does not breach the others.

**Layer 1 - Structural (TypeScript):**
- DriveReaderService exports IDriveStateReader interface with only: getCurrentState(), driveState$ Observable
- No setDrive(), modifyRule(), updateBaseline() methods are exported
- Compile-time checking prevents accidental misuse

**Layer 2 - Process (OS-level):**
- Child process is a separate Node.js process with its own memory space
- Main process has no direct memory access to child's state
- IPC messages are the only communication channel
- Child can be restarted independently

**Layer 3 - Database (SQL role-based):**
```sql
-- Main app role (read-only on active rules)
GRANT SELECT ON drive_rules TO sylphie_app;
-- No INSERT, UPDATE, DELETE

-- Proposed rules (app can only insert)
GRANT SELECT, INSERT ON proposed_drive_rules TO sylphie_app;

-- Drive engine child (read-only)
CREATE ROLE drive_engine LOGIN;
GRANT SELECT ON drive_rules TO drive_engine;

-- Guardian admin (full control)
CREATE ROLE guardian_admin LOGIN;
GRANT ALL ON drive_rules TO guardian_admin;
```

**Trade-off:** Operational overhead (three separate enforcement mechanisms to maintain). Mitigated by: (a) all three are standard Node.js + SQL patterns, (b) Ashby's attack vector analysis shows no single point of failure, (c) edge case mitigations are documented in Ashby analysis.

**CANON alignment:** Immutable Standard 6. This is the authoritative interpretation of how write-protection is enforced.

### 4. DriveReaderService as read-only facade with Observable

**Decision:** Main process accesses drive state exclusively through DriveReaderService, which: (1) maintains cached latest DRIVE_SNAPSHOT, (2) exposes getCurrentState() and driveState$ Observable, (3) performs defensive copy to prevent external mutation, (4) validates snapshot coherence.

**Rationale (Drive + Forge):** Facade pattern centralizes IPC handling and provides single point of monitoring. Observable enables reactive subscribers (Decision Making, Communication can subscribe to drive changes). Defensive copy ensures external code cannot mutate the snapshot (which would be shared with the child). Coherence validation detects if the child process is corrupted (unvarying snapshots, out-of-range values).

**Coherence checks:**
```typescript
private validateSnapshot(snap: DriveSnapshot): void {
  // Not all zeros (child crashed)
  const sum = Object.values(snap).reduce((a, b) => a + b, 0);
  if (sum === 0) throw new DriveCoherenceError('All drives zero');

  // Not stuck at same value (child hung)
  if (this.lastSnapshot && snap.totalPressure === this.lastSnapshot.totalPressure
      && snap.timestamp - this.lastSnapshot.timestamp > 1000) {
    throw new DriveCoherenceError('Drive state unchanged for >1s');
  }

  // All values in [-10.0, 1.0] (negative = extended relief, not a bug)
  for (const [drive, value] of Object.entries(snap)) {
    if (value < -10 || value > 1) {
      throw new DriveCoherenceError(`${drive} out of range: ${value}`);
    }
  }
}
```

**Implementation detail:**
```typescript
getCurrentState(): DriveSnapshot {
  // Defensive copy prevents external mutation
  return JSON.parse(JSON.stringify(this.latestSnapshot));
}

get driveState$(): Observable<DriveSnapshot> {
  return this.driveState$.asObservable();
}
// No write methods exist
```

**CANON alignment:** Immutable Standard 6, one-way communication and read-only interface requirement.

### 5. ActionOutcomeReporterService: fire-and-forget async queue

**Decision:** Decision Making and Communication report action outcomes via ActionOutcomeReporterService.reportOutcome(), which queues the message asynchronously and sends it to the child process via IPC. No synchronous response or ACK is expected.

**Rationale (Drive + Forge):** Synchronous wait-for-ACK would block Decision Making on the IPC latency (10ms per tick). Fire-and-forget prevents decision latency from interfering with drive computation. Messages are queued (FIFO), so order is preserved. If the child temporarily lags, messages accumulate in the queue and are processed on next tick. If child crashes and restarts, in-flight messages may be lost, but the outcome is recorded in TimescaleDB so it can be replayed if needed.

**Trade-off:** No immediate confirmation that the outcome reached the drive engine. Mitigated by: (a) outcomes are also written to TimescaleDB by Decision Making, (b) if outcomes are lost, they don't affect model correctness — only the performance of the current session, (c) queue size is bounded; if queue exceeds limit, oldest messages are dropped (logged).

**Implementation detail:**
```typescript
private outcomeQueue: ActionOutcomeMessage[] = [];

reportOutcome(action: Action, outcome: Outcome): void {
  const msg: ActionOutcomeMessage = {
    type: 'ACTION_OUTCOME',
    payload: { actionId: action.id, outcome, timestamp: Date.now() },
  };

  this.outcomeQueue.push(msg);

  // Async flush (non-blocking)
  setImmediate(() => {
    while (this.outcomeQueue.length > 0) {
      const msg = this.outcomeQueue.shift();
      driveProcess.send(msg);
    }
  });
}
```

**CANON alignment:** Contingency Requirement (Immutable Standard 2) — every action outcome must be reported to the drive engine so contingencies can apply. This service ensures outcomes reach the engine asynchronously without blocking decisions.

### 6. RuleProposerService: PostgreSQL INSERT-only to proposed_drive_rules

**Decision:** When the Drive Engine (or Learning subsystem) proposes a new drive rule, IRuleProposer.proposeRule() executes INSERT into proposed_drive_rules (PostgreSQL). The rule does NOT activate automatically. Guardian must explicitly move it from proposed_drive_rules to drive_rules via separate admin interface.

**Rationale (Forge + Canon + Ashby):** Rule proposal should be gated by the guardian to prevent the system from optimizing its own reward signal (Campbell's Law). The system can suggest ("I think high Satisfaction on success would motivate me"), but cannot enact. Database role enforcement prevents the application process from modifying drive_rules directly.

**Implementation detail:**
```typescript
// src/drive-engine/rule-proposer/rule-proposer.service.ts

async proposeRule(rule: ProposedDriveRule): Promise<void> {
  // Only INSERT permission
  await this.db.query(
    `INSERT INTO proposed_drive_rules
      (trigger, effect, confidence, proposed_by, created_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [rule.trigger, rule.effect, rule.confidence, rule.proposedBy]
  );

  // Log for guardian review
  this.logger.info(`Rule proposed: ${rule.trigger} -> ${rule.effect}`);
}

// Guardian interface (separate from app process)
// Admin CLI or dashboard: SELECT from proposed_drive_rules, then:
// UPDATE drive_rules SET ... WHERE id = $1 (requires admin credentials)
```

**Credential segregation:**
- App process: `sylphie_app` role (INSERT on proposed_drive_rules, SELECT on drive_rules)
- Guardian admin: `guardian_admin` role (full control on drive_rules)
- Drive engine child: `drive_engine` role (SELECT on drive_rules only)

**CANON alignment:** Immutable Standard 5 (Guardian Asymmetry). Guardian has final authority over drive rules. System proposes; guardian approves.

### 7. 100Hz tick loop with eventual consistency

**Decision:** Drive Engine runs a tick loop at 100Hz (~10ms per tick). On each tick: reads queued outcomes, applies contingencies, updates drives, publishes DRIVE_SNAPSHOT to main process. Main process caches the latest snapshot; consumers may read snapshots 1-2 ticks stale (~10-20ms).

**Rationale (Drive + Forge):** High tick rate (100Hz) provides fine-grained drive dynamics. Eventual consistency (1-2 ticks stale) avoids synchronous blocking. Decision Making doesn't need real-time drive state — a drive state from 10ms ago is sufficient for selecting an action. This is analogous to video games where input latency is 16-33ms (refresh rate) and the game remains responsive.

**Trade-off:** Main process reads slightly stale drive state. In edge cases where drive state changes rapidly (e.g., rapid swing from high Anxiety to relief), the main process may see a slightly delayed snapshot. Acceptable because: (a) drive state doesn't change infinitely fast (it accumulates and decays), (b) 10-20ms is imperceptible to human observers, (c) alternative of synchronous reads would block drive computation.

**Implementation detail:**
```typescript
// Child process: tick loop
const TICK_INTERVAL_MS = 10;

async function tick() {
  // 1. Drain outcome queue
  while (outcomeQueue.length > 0) {
    const outcome = outcomeQueue.shift();
    applyOutcome(outcome);
  }

  // 2. Compute drives
  computeDrives();

  // 3. Apply contingencies
  applySatisfactionHabituation();
  applyAnxietyAmplification();
  // ... etc

  // 4. Cross-modulation
  applyCrossModulation();

  // 5. Clamp to [-10.0, 1.0] (negative values = extended relief, drive stays quiet)
  clampDrives();

  // 6. Publish snapshot
  process.send({ type: 'DRIVE_SNAPSHOT', payload: snapshot });

  // 7. Schedule next tick
  setTimeout(tick, TICK_INTERVAL_MS);
}
```

**CANON alignment:** Core Philosophy 2 (Dual-Process Cognition). Drive state is the input to Type 1/Type 2 arbitration, which is computed in Decision Making on a faster timescale. Eventual consistency is acceptable.

### 8. 12-drive cross-modulation as coupled dynamical system

**Decision:** The 12 drives are modeled as a coupled dynamical system where each drive's state depends not only on its own accumulation/decay but also on the state of other drives. Cross-modulation rules (e.g., "high Anxiety increases Integrity pressure") are applied after individual drive updates and before clamping.

**Rationale (Ashby + Skinner):** Drives are not independent. System Health affects the baseline accumulation rate of other drives (higher System Health → more resilient to stress). Anxiety affects exploration willingness (high Anxiety → reduced Curiosity). Satisfaction affects Boredom (high Satisfaction → reduced Boredom). These interactions create a stable, self-regulating system in healthy conditions.

**Coupled dynamics prevent attractor states:**
- **Depressive Attractor (all drives low):** Prevented by cross-modulation: if Satisfaction is low, Curiosity increases (exploration drive), which can generate positive outcomes and restore Satisfaction.
- **Manic Attractor (all drives high):** Prevented by: high Satisfaction produces habituation, reducing future Satisfaction; high Anxiety limits exploration (protective mechanism).

**Trade-off:** Cross-modulation coefficients must be carefully tuned. If coefficients are wrong, the system may have unstable equilibria (runaway positive feedback). Mitigated by: (a) Ashby's stability analysis, (b) extensive testing during Phase 1, (c) conservative initial coefficients.

**Implementation detail (pseudocode):**
```typescript
// After base drives update, before clamping:
function applyCrossModulation(drives: Drives): Drives {
  // Anxiety increases Integrity pressure
  if (drives.anxiety > 0.7) {
    drives.integrity += drives.anxiety * 0.2; // up to 0.2 additional
  }

  // High Satisfaction reduces Curiosity
  drives.curiosity *= (1 - 0.3 * drives.satisfaction);

  // High Anxiety reduces Curiosity (cautious behavior)
  drives.curiosity *= (1 - 0.4 * drives.anxiety);

  // ... more rules

  return drives;
}
```

**CANON alignment:** Behavioral Contingency Structure (cross-modulation prevents attractor states).

### 9. Satisfaction habituation curve: +0.20, +0.15, +0.10, +0.05, +0.02

**Decision:** On successful action, Satisfaction relief is: 1st success on a topography = +0.20, 2nd consecutive = +0.15, 3rd = +0.10, 4th = +0.05, 5th+ = +0.02. Counter resets if a different action is selected.

**Rationale (Skinner + Ashby):** This implements a ratio strain contingency within a single behavioral topography. The Matching Law (Herrnstein) predicts that decreasing reinforcement on one behavior while other behaviors remain available will cause the system to reallocate effort toward higher-paying alternatives. This shapes behavioral diversity: the system switches actions as returns on the current action diminish.

**Critical requirement for personality emergence:** This contingency ONLY works if the Decision Making subsystem generates behavioral alternatives. Without alternatives, the system habituates to all known behaviors and returns to baseline. This is the Depressive Attractor. E4 implementation must document this dependency on E5 (Decision Making).

**Trade-off:** Tracking consecutive successes requires querying TimescaleDB for the last 5 actions of the same type. This is slightly expensive but necessary for correctness. Mitigated by: (a) caching recent action history, (b) queries on action completion (asynchronous).

**Implementation detail:**
```typescript
async function applySatisfactionHabituation(
  action: Action,
  outcome: Outcome
): Promise<number> {
  if (outcome !== 'success') return 0; // Only on success

  // Count consecutive successes on this topography
  const recentActions = await this.db.query(
    `SELECT COUNT(*) as count FROM events
     WHERE action_id = $1 AND outcome = 'success'
     AND timestamp > NOW() - INTERVAL '1 minute'
     ORDER BY timestamp DESC LIMIT 5`,
    [action.id]
  );

  const count = recentActions[0].count;
  const reliefMap = [0.20, 0.15, 0.10, 0.05, 0.02];
  const relief = reliefMap[Math.min(count - 1, 4)];

  return relief;
}
```

**CANON alignment:** Behavioral Contingency Structure (Satisfaction Habituation Curve).

### 10. Anxiety amplification: 1.5x confidence reduction under high anxiety

**Decision:** When an action is executed under high Anxiety (>0.7) and the outcome is negative, the confidence reduction is 1.5x the normal value. Normal reduction on negative outcome is -0.10; under anxiety, it becomes -0.15.

**Rationale (Skinner + Ashby):** This is severity-dependent punishment. The system learns "errors under stress are especially bad; avoid risky exploration when anxious." This prevents learned helplessness: the system avoids failure spirals by preferring proven (high-confidence) behaviors when anxious, while still remaining active (doesn't freeze).

**Behavioral prediction:**
- Anxiety < 0.7: System explores freely, normal confidence reductions on failure
- Anxiety > 0.7: System preferentially selects high-confidence Type 1 behaviors, novel actions carry amplified penalty
- Chronic high Anxiety without relief mechanisms: System converges on small set of proven behaviors, never attempts novelty (Depressive Attractor path)

**Critical requirement:** Anxiety must have natural decay mechanisms. E5 must provide actions that reduce Anxiety without requiring risky exploration (e.g., requesting guardian reassurance, consolidating existing knowledge).

**Trade-off:** The exact amplification factor (1.5x) is a tuning parameter. Too low (1.1x) and it doesn't deter enough; too high (2.0x+) and it over-penalizes. The value 1.5x is conservative and subject to adjustment during Phase 1 testing.

**CANON alignment:** Behavioral Contingency Structure (Anxiety Amplification).

### 11. Guilt repair: compound contingency requiring BOTH acknowledgment AND change

**Decision:** Guilt relief is structured as a compound contingency with three pathways:
- Acknowledgment only: Guilt -0.10 (partial relief ~33%)
- Behavioral change only: Guilt -0.15 (partial relief ~50%)
- Both together: Guilt -0.30 (full relief 100%)

The system learns to chain both responses for maximum relief.

**Rationale (Skinner + Canon):** This shapes a sophisticated corrective sequence: verbal acknowledgment (low cost, immediate) followed by behavioral change (high cost, delayed). Acknowledgment alone is insufficient; the system learns behavioral change is necessary for full relief. This prevents the system from "gaming" the contingency by only apologizing without improving.

**Behavioral sequence (predicted):**
1. **Weeks 1-2 (discovery):** System discovers acknowledgment produces relief; begins apologizing
2. **Weeks 3-4 (refinement):** System notices acknowledgment alone provides incomplete relief; attempts behavioral change
3. **Weeks 5+ (maturity):** System chains both: acknowledges AND changes behavior for full relief

**Critical requirement:** Behavioral change detection must be accurate. E4 must be able to detect when the system makes the same error in a similar context and recognize that avoiding it is behavioral change. This is non-trivial because "similar context" requires fuzzy matching.

**Example of behavioral change detection:**
```typescript
// Previously: Sylphie made error X in context Y, was corrected, guilt increased
// Now: system attempts action in context Y again
// Question: Did the system make error X again, or try something different?

const previousError = {
  actionId: 'speak_when_guardian_busy',
  context: { guardian_availability: 'busy' },
  timestamp: Date.now() - 3600000 // 1 hour ago
};

const currentAction = {
  actionId: 'request_permission_first', // Different action!
  context: { guardian_availability: 'busy' },
  timestamp: Date.now()
};

// Behavioral change detected: system chose different action in same context
// Trigger Guilt -0.15 (or -0.30 if also acknowledged)
```

**Trade-off:** Behavioral change detection requires semantic understanding of action categories and context similarity. Mitigated by: (a) using WKG entity types to group related actions, (b) context similarity measured via embedding distance, (c) conservative threshold (only trigger on high-confidence matches).

**CANON alignment:** Behavioral Contingency Structure (Guilt Repair Contingency).

### 12. Social comment quality: guardian response within 30s

**Decision:** When Sylphie initiates a comment (not responding to a question), if the guardian responds within 30 seconds, the system receives: Social -0.15 (relief) + Satisfaction +0.10 (bonus). This shapes high-quality social communication.

**Rationale (Skinner + Canon):** This is discrimination training. The guardian's response pattern becomes a discriminative stimulus. Comments that get quick responses are S+ (reinforced); comments that don't are S- (extinguished). Over weeks, the system learns to produce comments that elicit guardian engagement, developing "natural" social communication patterns.

**Critical insight (second-order cybernetics):** The guardian shapes the system as much as the system shapes itself. If the guardian responds to problems/concerns, Sylphie learns to express problems. If the guardian responds to interesting observations, Sylphie learns to be interesting. This is not a bug — it's a feature of behavioral shaping, and the guardian should be aware of it.

**Implementation detail:**
```typescript
// Communication subsystem timestamps Sylphie's initiated comments
recordSylphieComment({ timestamp, content, initiator: 'SYLPHIE' });

// When guardian responds, check if within 30s
const response = { timestamp, content };
const timeSinceComment = response.timestamp - commentTimestamp;

if (timeSinceComment <= 30000) { // 30 seconds
  // Extra reinforcement
  drives.social -= 0.15;  // Relief
  drives.satisfaction += 0.10; // Bonus

  // Record for social quality metrics
  recordSocialSuccess({ type: 'QUICK_RESPONSE', latency: timeSinceComment });
}
```

**Trade-off:** This contingency is highly dependent on guardian behavior. If guardian is unavailable or less engaged, Sylphie's social drive remains high (frustrated). This is not a system bug but a system design feature: the environment (guardian's responsiveness) shapes the personality.

**CANON alignment:** Behavioral Contingency Structure (Social Comment Quality).

### 13. Curiosity information gain: proportional reinforcement

**Decision:** Curiosity relief is proportional to the actual new information gained: relief = k * (new_nodes + Δconfidence), where k is a scaling factor. Revisiting known territory (zero new nodes, zero confidence change) produces zero relief.

**Rationale (Skinner + Ashby):** This is the gold standard of reinforcement design. The system that learns more gets more relief. This prevents reward hacking: a system could theoretically boost its Curiosity relief by investigating trivial details, but the proportional contingency rewards investigation of genuinely new domains.

**Information gain metrics:**
```typescript
const informationGain = {
  newNodes: count of nodes created in Knowledge graph in last minute,
  confidenceDeltas: sum of (newConfidence - oldConfidence) for updated nodes,
  resolvedErrors: count of prediction errors > 0.20 that are now < 0.10
};

const curiosityRelief =
  informationGain.newNodes * 0.05 +
  informationGain.confidenceDeltas * 0.10 +
  informationGain.resolvedErrors * 0.15;

drives.curiosity -= curiosityRelief;
```

**Critical requirement:** Information gain must be measured against actual WKG changes, not self-reported. E4 must query Neo4j to verify that new nodes were actually created (not just claimed by Learning). This prevents Learning from lying about how much it learned.

**Trade-off:** Requires real-time WKG queries from the Drive Engine child process. This adds network latency. Mitigated by: (a) lazy evaluation (compute information gain only when needed, not every tick), (b) caching recent node creation times in TimescaleDB for quick lookup.

**CANON alignment:** Behavioral Contingency Structure (Curiosity Information Gain).

### 14. Prediction accuracy evaluation: MAE computation

**Decision:** Drive Engine reads prediction outcomes from TimescaleDB. For each prediction, computes Mean Absolute Error (MAE): average of |predicted_value - actual_value| over last 10 predictions of same type. MAE feeds Type 1/Type 2 graduation logic (graduation requires MAE < 0.10 + confidence > 0.80).

**Rationale (Drive + Canon):** MAE is the objective measure of prediction accuracy. Unlike confidence (which can be gamed), MAE is grounded in actual prediction-reality correlation. By requiring MAE < 0.10, we ensure that Type 1 behaviors are not just high-confidence but also accurate. This prevents the system from becoming overconfident in incorrect predictions.

**Implementation detail:**
```typescript
async function computeMAE(predictionType: string, windowSize: number = 10): Promise<number> {
  const predictions = await this.db.query(
    `SELECT predicted_value, actual_value FROM predictions
     WHERE prediction_type = $1 AND created_at > NOW() - INTERVAL '1 hour'
     ORDER BY created_at DESC LIMIT $2`,
    [predictionType, windowSize]
  );

  if (predictions.length === 0) return 1.0; // No data: assume inaccurate

  const mae = predictions.reduce(
    (sum, p) => sum + Math.abs(p.predicted_value - p.actual_value),
    0
  ) / predictions.length;

  return mae;
}
```

**Trade-off:** MAE calculation requires storing predictions and outcomes in TimescaleDB. If TimescaleDB is down, MAE computation fails. Mitigated by: (a) fallback to in-memory prediction cache, (b) degrade gracefully (use confidence alone for arbitration if MAE unavailable).

**CANON alignment:** Immutable Standard 3 (Confidence Ceiling) and Type 1/Type 2 Graduation.

### 15. Cold-start dampening: reduced opportunity priority in early sessions

**Decision:** During sessions 1-N (N pending Jim approval), prediction failures generate Opportunities with reduced priority weight. Specifically, opportunity.priority *= (sessionNumber / N) during cold-start. After session N, dampening ends and full priority is assigned.

**Rationale (Ashby + Canon):** Early in learning, the system makes many predictions that fail because the WKG is sparse and the system has few learned patterns. Without dampening, each failure would generate an Opportunity, flooding the Planning backlog with untested procedures. With dampening, the system accumulates experience first, then generates Opportunities for patterns that recur. This prevents the Prediction Pessimist attractor (early floods of low-quality procedures).

**Trade-off:** Cold-start dampening must end at some point, or the system will never generate new procedures. The duration N is a tuning parameter. Mitigated by: (a) make N observable (log when dampening ends), (b) Jim can adjust N based on Phase 1 observations.

**Example:**
- Session 1: prediction failure → opportunity.priority *= 0.1
- Session 5: prediction failure → opportunity.priority *= 0.5
- Session 10: prediction failure → opportunity.priority *= 1.0 (full priority)
- Session 11+: prediction failure → opportunity.priority *= 1.0 (no dampening)

**CANON alignment:** Known Attractor States (Prediction Pessimist prevention).

---

## Decisions Requiring Jim

These seven decisions must be resolved before E4 implementation begins:

### 1. Theater Prohibition enforcement boundary (pre-flight vs. post-flight)

**Issue:** The Theater Prohibition (Immutable Standard 1) states that emotional expressions must correlate with actual drive state. The check is directional:
- **Pressure expression** (distress, need, urgency): drive must be > 0.2 to be authentic. Expressing distress with a low drive is theatrical.
- **Relief expression** (contentment, calm, happiness): drive must be < 0.3 to be authentic. Expressing contentment with a high drive is theatrical.
Both violations receive zero reinforcement.

The question is: **Where does the enforcement happen?**

**Option A (Pre-flight, E6 responsibility):**
- Communication receives drive snapshot from Drive Engine
- Before sending response to user, checks: does response express emotion? If yes, does it pass the directional drive check?
- If not, don't send response (or flag for guardian approval)
- Prevents non-contingent emotional expression from occurring

**Option B (Post-flight, E4 responsibility):**
- Communication sends response without checking
- Drive Engine later sees outcome and applies zero reinforcement (Satisfaction += 0)
- Expression did occur, but is not reinforced
- System learns "expressing emotions I don't have doesn't produce relief"

**Option C (Both):**
- E6 pre-flight check prevents expression (stricter)
- E4 post-flight enforcement backstops if check fails (safety net)

**Recommendation:** Option C (both). E6 prevents theatrical responses pre-flight. E4 backstops if E6 check fails or if an autonomous (non-communication) action expresses a theatrically mismatched drive state.

**Decision needed:** Which option? (Planning assumes Option C.)

**Status:** APPROVED (2026-03-29) — Option C (both E5+E6 pre-flight, E4 post-flight backstop). Updated to directional check per CANON amendment.

### 2. Guardian Asymmetry application with drive rules and opportunities

**Issue:** The CANON specifies Guardian Asymmetry as 2x weight for confirmation and 3x for correction. But where exactly does this apply in E4's context?

**Current confusion:**
- Guardian confirmation of LLM-generated knowledge: This happens in E3/E7 (Knowledge/Learning), not E4. The 2x multiplier applies to the confidence update formula.
- Guardian confirmation of a proposed drive rule: This happens when guardian moves rule from proposed_drive_rules to drive_rules. Should the rule's effect be 2x-weighted?
- Guardian confirmation of an Opportunity: Should Opportunity priority be 2x-weighted?

**Options:**
1. **Guardian Asymmetry applies only to confidence updates** (E3/E7 responsibility)
2. **Guardian Asymmetry applies to rule weights** (E4 must weight confirmed rules at 2x)
3. **Guardian Asymmetry applies to Opportunity priority** (E4 must weight confirmed opportunities at 2x)
4. **All of the above**

**Recommendation:** The CANON specifies Guardian Asymmetry as a general principle: "Guardian feedback always outweighs algorithmic evaluation." This suggests it should apply across the board (option 4). However, implementation details must be specified by Jim.

**Decision needed:** Where should Guardian Asymmetry weights (2x/3x) apply in E4? Options: rule weights, Opportunity priority, both, or neither (defer to E7)?

**Status:** APPROVED (2026-03-29) — Option 4 (all: confidence updates + rule weights + opportunity priority)

### 3. Cold-start dampening duration (N)

**Issue:** E4 implements cold-start dampening so that early prediction failures don't flood the backlog with untested procedures. But how long should dampening last?

**Options:**
- **N sessions:** e.g., 10 sessions (Jim observes system for 10 sessions before allowing full Opportunity priority)
- **N events:** e.g., 500 events (dampening ends after 500 TimescaleDB events across all types)
- **Until prediction accuracy stabilizes:** e.g., when MAE < 0.15 for 50 consecutive decisions

**Trade-off:**
- Too short (N=3): System floods backlog too early, generates low-quality procedures
- Too long (N=50): System takes forever to generate any procedures, never develops Type 1 behaviors

**Recommendation:** N sessions with an observable log so Jim can adjust. Start with N=10 and monitor.

**Decision needed:** What is the cold-start dampening duration? (N sessions, N events, MAE stabilization, or other?)

**Status:** APPROVED (2026-03-29) — N=10 sessions, configurable, with observable log

### 4. Self-evaluation timescale and circuit breakers

**Issue:** E4 reads KG(Self) on some timescale to adjust drive baselines based on self-assessed capabilities. But what is the timescale? Every tick (100Hz)? Every 10 ticks (~100ms)? Every 60 ticks (~600ms)? Every second?

Also, what prevents ruminative loops (system gets stuck evaluating itself, spiraling into negative self-assessment)?

**Options for timescale:**
- **Every tick (100Hz):** Real-time self-awareness, but expensive (Grafeo queries every 10ms)
- **Every 10 ticks (~100ms):** Good balance
- **Every 60 ticks (~600ms):** Slow self-evaluation, minimizes rumination risk
- **Every 1000 ticks (~10s):** Very slow, almost independent

**Options for circuit breakers:**
- **Max consecutive negative assessments:** If Self KG says "I'm bad at X" for 10 ticks in a row, flag as ruminative loop and pause self-eval
- **Max negative confidence change rate:** If self-assessed capability drops >0.05 per second, pause self-eval
- **Exponential backoff:** If negative assessment repeats, increase time until next self-eval

**Recommendation:** Every 100ms timescale with circuit breaker on consecutive negative assessments (max 5 consecutive, then pause for 5 seconds).

**Decision needed:** What timescale for self-evaluation? (Tick, 10ms, 100ms, 1s?) What circuit breaker prevents rumination loops?

**Status:** APPROVED (2026-03-29) — Every 100ms (10 ticks), circuit breaker after 5 consecutive negative assessments (pause 5s)

### 5. Opportunity priority scoring beyond basic classification

**Issue:** E4 classifies opportunities as "recurring" vs. "high-impact" vs. "low-priority". But what determines priority numerically?

**Current specification:** Opportunities have priority based on classification. But this is vague.

**Options:**
- **Recency weighting:** Recent failures have higher priority (newer = more relevant)
- **Magnitude weighting:** Larger prediction errors (MAE > 0.20) have higher priority
- **Frequency weighting:** Failures that repeat have exponentially higher priority
- **Behavioral alternatives:** If many alternative behaviors exist, boost opportunity priority (more options to learn)

**Recommendation:** Combine frequency + magnitude: `priority = log(frequency) * MAE`. Opportunities from frequent, large errors are highest priority.

**Decision needed:** What formula determines Opportunity priority? (Frequency? Magnitude? Recency? All?)

**Status:** APPROVED (2026-03-29) — Combined: priority = log(frequency) * MAE

### 6. Drive accumulation and decay rates per drive

**Issue:** The CANON reserves detailed accumulation formulas in A.14. E4 needs specification for:
- **Base accumulation rate:** How much does each drive increase per tick absent any outcome?
- **Decay rate:** Do drives naturally decay? At what rate?
- **Cross-modulation coefficients:** How much does one drive affect another?

Without this, E4 cannot be implemented.

**Current specification:** The CANON specifies contingencies (Satisfaction +0.20 on success, etc.) but not baseline accumulation or decay.

**Recommendation:** Declare these as CANON A.14 gaps requiring Jim specification. E4 planning can outline the structure, but implementation must wait.

**Decision needed:** Specify CANON A.14 (drive accumulation/decay rates) before E4 implementation.

**Status:** APPROVED (2026-03-29) — Rates specified in CANON A.14 amendment (see wiki/CANON.md)

### 7. Full behavioral contingency tables (CANON A.15)

**Issue:** The CANON reserves full behavioral contingency tables in A.15. E4 cannot implement the five contingencies without detailed specifications:

1. **Satisfaction Habituation:** How exactly are "consecutive successes" tracked? Same action_id? Same action type? Over what time window? And the curve (+0.20, +0.15, ...) — is this exact or adjustable per action?

2. **Anxiety Amplification:** Confirmed threshold >0.7? And "1.5x confidence reduction" — reduction of what base? Is it 1.5x * normal_reduction, or 1.5x * absolute_confidence_loss?

3. **Guilt Repair:** What counts as "acknowledgment"? Explicit speech? Detected via LLM output? And "behavioral change in context Y" — how is context similarity computed?

4. **Social Comment Quality:** What is "guardian response"? Any response? Or specific response types? And the 30-second window — is it strict or adjustable?

5. **Curiosity Information Gain:** Is information gain measured as node_count? Confidence deltas? Resolved errors? All three? And what are the per-unit weights?

**Recommendation:** Schedule CANON A.15 specification with Jim as blocking dependency for E4-T007 (behavioral contingencies).

**Decision needed:** Specify CANON A.15 (Full Behavioral Contingency Tables) before E4-T007 implementation.

**Status:** APPROVED (2026-03-29) — Tables specified in CANON A.15 amendment (see wiki/CANON.md)

---

## Summary of Approved Decisions

**Approved by planning (no Jim input needed):**
1. Separate Node.js process via child_process.fork()
2. One-way IPC communication
3. Three-layer write protection (structural, process, database)
4. DriveReaderService read-only facade with Observable
5. ActionOutcomeReporterService fire-and-forget queue
6. RuleProposerService INSERT-only to proposed_drive_rules
7. 100Hz tick loop with eventual consistency
8. 12-drive cross-modulation as coupled dynamical system
9. Satisfaction habituation curve
10. Anxiety amplification under high anxiety
11. Guilt repair compound contingency
12. Social comment quality discrimination training
13. Curiosity information gain proportional reinforcement
14. Prediction accuracy evaluation (MAE computation)
15. Cold-start dampening (duration pending Jim approval)

**Approved by Jim (2026-03-29):**
1. Theater Prohibition enforcement boundary — Option C (both E5+E6 pre-flight, E4 post-flight backstop), directional check
2. Guardian Asymmetry — Option 4 (all: confidence updates + rule weights + opportunity priority)
3. Cold-start dampening duration — N=10 sessions, configurable, with observable log
4. Self-evaluation timescale and circuit breakers — 100ms (10 ticks), circuit breaker after 5 consecutive negatives (pause 5s)
5. Opportunity priority scoring formula — priority = log(frequency) * MAE
6. CANON A.14 (drive accumulation/decay rates) — rates specified in CANON A.14 amendment
7. CANON A.15 (full behavioral contingency tables) — tables specified in CANON A.15 amendment
