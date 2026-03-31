# Epic 5: Decisions

## Decisions Made During Planning

### 1. Event-driven decision cycle with 5Hz idle tick

**Decision:** Decision Making processes inputs when they arrive via event subscription (EXTERNAL inputs from Communication, INTERNAL from Drive Engine opportunities), not on a fixed clock. A 5Hz idle tick (every 200ms) ensures the system can initiate autonomous actions during quiet periods when no external input is received (e.g., boredom-driven exploration, curiosity-motivated research).

**Rationale (Cortex + Forge + Piaget):** The CANON specifies event-driven inputs in Subsystem 1. However, Boredom and Curiosity drives can only produce observable behavior if the system has a mechanism to initiate actions without waiting for external stimuli. The 5Hz idle tick provides that mechanism: if the event queue is empty and the Boredom drive is high, the system can decide autonomously. 5Hz is slow enough to avoid constant activity (resource drain, false activity), fast enough to respond to boredom within 200ms (imperceptible to human observer). Piaget's developmental theory emphasizes autonomous exploration; the idle tick enables it.

**Trade-off:** A periodic tick introduces a weak clock-based element into an otherwise event-driven architecture. This is mitigated by: (a) the tick is purely a check-in mechanism, not the primary driver of decisions (events dominate), (b) the tick is very slow (5Hz, not 100Hz), (c) if Decision Making is blocked, the tick does not accumulate backlog, it simply skips that cycle.

**Implementation detail:** The Executor Engine subscribes to an Observable that emits: (a) inputs from Communication, (b) opportunities from Drive Engine, and (c) a periodic idle tick every 200ms. When the event queue is empty and idle tick fires, IDLE → CATEGORIZING uses Boredom/Curiosity as the drive category instead of external input.

```typescript
// decision-making.service.ts
private setupEventLoop(): void {
  merge(
    this.communicationService.inputReceived$,
    this.driveEngineService.opportunityCreated$,
    interval(200) // 5Hz idle tick
  ).pipe(
    filter(() => !this.executor.isRunning),
  ).subscribe((event) => {
    this.executor.processEvent(event);
  });
}
```

**CANON alignment:** Subsystem 1 architecture (event-driven inputs) + Behavioral Contingency Structure (Boredom/Curiosity require idle time to express).

---

### 2. 8-state Executor Engine with explicit dual-process states

**Decision:** The Executor Engine is a state machine with 8 states: IDLE → CATEGORIZING → PREDICTING → ARBITRATING → RETRIEVING → EXECUTING → OBSERVING → LEARNING. This refactors v1's 6-state machine by explicitly separating PREDICTING and ARBITRATING. The 8-state design enforces formal dual-process cognition: PREDICTING generates both Type 1 and Type 2 candidates in parallel; ARBITRATING explicitly competes them.

**Rationale (Cortex + Atlas):** The v1 architecture combined prediction and arbitration into one state. This made it difficult to measure: how many predictions did we generate? How many Type 1 candidates competed with Type 2? The 8-state design separates concerns: PREDICTING focuses on generation (quality and diversity of candidates), ARBITRATING focuses on selection (confidence comparison, threshold enforcement). This separation enables detailed logging and debugging of the dual-process mechanism.

**Trade-off:** More states means more transitions to test and more opportunities for state-machine bugs. Mitigated by: (a) transitions are deterministic and linear (no loops or parallel branches), (b) each state has a clear termination condition, (c) extensive logging at each state boundary enables debugging.

**Implementation detail:** State transitions are triggered by completion of prior state work:

```typescript
// executor-engine.types.ts
export enum ExecutorState {
  IDLE = 'IDLE',           // Waiting for input or idle tick
  CATEGORIZING = 'CATEGORIZING',  // Classify input to drive category
  PREDICTING = 'PREDICTING',      // Generate Type 1 + Type 2 candidates
  ARBITRATING = 'ARBITRATING',    // Compare, select action, handle ties
  RETRIEVING = 'RETRIEVING',      // Fetch full procedure, validate
  EXECUTING = 'EXECUTING',        // Motor/comms execute action
  OBSERVING = 'OBSERVING',        // Record outcome to TimescaleDB
  LEARNING = 'LEARNING',          // Encode episode, update graph
}
```

**CANON alignment:** Core Philosophy 2 (Dual-Process Cognition). This design makes Type 1/Type 2 competition explicit and measurable.

---

### 3. Episodic Memory as in-memory ring buffer with TimescaleDB backing

**Decision:** Recent episodes (up to 50) are kept in memory as a ring buffer for fast retrieval during CATEGORIZING and PREDICTING states. Full episode data is immediately written to TimescaleDB. Consolidated semantic content is extracted to the WKG by Learning (E3/E7) asynchronously. This creates a three-tier memory system: hot (in-memory), warm (TimescaleDB), cold (WKG).

**Rationale (Cortex + Luria):** Luria's neuropsychological framework distinguishes hippocampal (episodic, detailed, temporary) from cortical (semantic, abstract, durable) memory. The in-memory buffer provides the hippocampal function: fast, context-rich retrieval during decision cycles. TimescaleDB provides long-term episodic access (for learning consolidation), and the WKG provides semantic storage. This three-tier design mirrors biological consolidation: recent experiences are episodic, then gradually become semantic over hours.

**Trade-off:** The in-memory ring buffer consumes 50 * ~2KB per episode = ~100KB RAM. This is negligible. Larger trade-off: if the main process crashes, recent episodes are lost (only TimescaleDB survives). Mitigated by: (a) TimescaleDB is written immediately, (b) episodes lost on crash are not critical (the system doesn't need to remember every micro-decision), (c) the in-memory buffer is a performance optimization, not critical to correctness.

**Implementation detail:**

```typescript
// episodic-memory.types.ts
export interface Episode {
  id: string;
  timestamp: number;
  source: 'EXTERNAL' | 'INTERNAL';
  inputContent: string;
  driveState: DriveSnapshot;
  predictions: Prediction[];
  selectedAction: Action;
  outcome: Outcome;
  latencyMs: number;
  attentionLevel: number; // [0, 1]
  arousalLevel: number;   // [0, 1]
  encodingDepth: 'SHALLOW' | 'NORMAL' | 'DEEP';
}

// episodic-memory.service.ts
private episodeBuffer: RingBuffer<Episode> = new RingBuffer(50);

async recordEpisode(episode: Episode): Promise<void> {
  // 1. Hot store (in-memory, O(1))
  this.episodeBuffer.push(episode);

  // 2. Warm store (TimescaleDB, async)
  this.eventService.recordEpisode(episode).catch(e => {
    this.logger.error('Episode write to TimescaleDB failed', e);
  });
}
```

**CANON alignment:** Subsystem 1, Episodic Memory component. Systems Consolidation Theory from Luria's framework.

---

### 4. Encoding gating via attention/arousal product

**Decision:** Not every input creates an episode. Encoding depth is determined by: `encodingDepth = f(attention, arousal, drive state)`. If attention and arousal are both high, encoding is DEEP (full detail, high salience). If either is low, encoding is SHALLOW (summary only, low salience). If both are very low (< 0.2 each), encoding may be SKIPPED entirely.

**Rationale (Cortex + Luria + Neuroscience):** Biological hippocampal encoding is gated by arousal (norepinephrine system) and attention (acetylcholine system). In humans, the same stimulus is encoded differently depending on attention state: you don't remember things you don't attend to, even if aroused. This gating prevents episodic memory from being flooded with trivial details. The formula should be multiplicative (both attention AND arousal required for deep encoding), not additive.

**Trade-off:** Requires real-time attention and arousal estimation. Attention can be estimated from input content complexity and WKG match (new information → high attention). Arousal is provided by Drive Engine (System Health, Anxiety, Curiosity contribute). This adds latency to CATEGORIZING state, but the computation is simple (two multiplications).

**Implementation detail:**

```typescript
// episodic-memory.service.ts
private computeEncodingDepth(
  attention: number,
  arousal: number,
  driveState: DriveSnapshot
): 'DEEP' | 'NORMAL' | 'SHALLOW' | 'SKIP' {
  const product = attention * arousal;

  // Arousal bonus from drives
  const awe = (driveState.curiosity + driveState.anxiety) / 2;
  const adjustedArousal = Math.min(1.0, arousal + 0.2 * awe);

  if (product > 0.6) return 'DEEP';      // Both high
  if (product > 0.3) return 'NORMAL';    // Mixed
  if (product > 0.1) return 'SHALLOW';   // Low
  return 'SKIP';                          // Trivial
}
```

**CANON alignment:** Subsystem 1, Episodic Memory encoding gating (referenced in Cortex analysis as critical design).

---

### 5. 4-tier episode degradation with semantic consolidation

**Decision:** Episodes are retained in the in-memory buffer with a 4-tier degradation profile: (1) Fresh (<1h): full detail, always available. (2) Recent (1-24h): key events and predictions only, but stored in TimescaleDB. (3) Consolidated (>24h): semantic summary + links to WKG nodes. (4) Archived (>7d): stub with timestamp and salience score only.

**Rationale (Cortex + Luria):** This implements Luria's Systems Consolidation Theory. Recent experiences are episodic (detailed); consolidated experiences are semantic (abstracted). Fresh episodes need full detail for PREDICTING state (we might predict from recent context). Consolidated episodes contribute to the WKG and should be queried via Knowledge subsystem, not episodic memory. Archived episodes are nearly useless but kept as a stub for temporal context.

**Trade-off:** Degradation requires periodic maintenance cycles (when? who triggers it?). Mitigated by: (a) degradation is lazy—when an episode is queried, check its age and degrade on-demand, (b) Learning subsystem triggers consolidation on pressure from Cognitive Awareness drive, (c) scheduled maintenance can run during low-activity periods.

**Implementation detail:**

```typescript
// episodic-memory.types.ts
export interface EpisodeStub {
  id: string;
  timestamp: number;
  salience: number;      // Importance score
  wkgNodeIds: string[];  // Links to WKG nodes created from this episode
}

// episodic-memory.service.ts
async getEpisode(episodeId: string): Promise<Episode | EpisodeStub> {
  const episode = this.episodeBuffer.get(episodeId);
  if (!episode) return null;

  const age = Date.now() - episode.timestamp;

  if (age < 3600000) return episode; // Fresh: full detail
  if (age < 86400000) {              // Recent: key events only
    return {
      id: episode.id,
      timestamp: episode.timestamp,
      driveState: episode.driveState,
      selectedAction: episode.selectedAction,
      outcome: episode.outcome,
      // (omit detailed predictions, input content)
    };
  }

  // Consolidated: fetch from WKG via Learning subsystem
  return this.learningService.getConsolidatedEpisode(episodeId);
}
```

**CANON alignment:** Subsystem 1, Episodic Memory degradation (Luria framework). Subsystem 3 (Learning) consolidation pipeline.

---

### 6. Max 5 Inner Monologue candidates with Cowan's limit

**Decision:** During PREDICTING state, the system generates up to 5 candidate actions to compete in ARBITRATING. Of these, up to 3 are Type 1 (graph-based reflexes), and up to 2 are Type 2 (LLM-generated). If fewer than 5 candidates can be generated, the system accepts fewer (minimum 1).

**Rationale (Cortex + Forge + Cognitive Science):** Cowan's working memory limit is 4±1 items. Generating more than 5 candidates would exceed working memory and increase decision latency. Additionally, beyond 5 candidates, marginal returns diminish: the best candidate is usually in the top 3, and comparison becomes O(n²) complex. Type 1 candidates are fast (graph retrieval); Type 2 is slow (LLM invocation). Limiting Type 2 to 2 candidates prevents the LLM from dominating (burning compute budget and latency).

**Trade-off:** Limiting candidates reduces diversity in ARBITRATING. If the best action is the 6th-best candidate, the system will never find it. Mitigated by: (a) candidates are ranked by confidence, and if the top 3 Type 1 all fail, the system tries Type 2, (b) Learning subsystem (E3) creates new WKG edges, expanding future Type 1 candidate space, (c) cold-start dampening (E4 decision) prevents early Type 2 over-reliance.

**Implementation detail:**

```typescript
// inner-monologue.service.ts
async generateCandidates(
  context: ActionContext,
  driveState: DriveSnapshot
): Promise<Prediction[]> {
  const type1Candidates = await this.actionRetriever
    .retrieveActions(context, limit: 3);

  let type2Candidates: Prediction[] = [];
  if (type1Candidates.length < 3) {
    // Fewer Type 1 candidates, leave room for Type 2
    const type2Limit = 5 - type1Candidates.length;
    type2Candidates = await this.llmService
      .generatePredictions(context, driveState, limit: type2Limit);
  } else {
    // 3+ Type 1 candidates; only add Type 2 if diversity needed
    type2Candidates = [];
  }

  return [...type1Candidates, ...type2Candidates].slice(0, 5);
}
```

**CANON alignment:** Core Philosophy 2 (Dual-Process Cognition). Cognitive Science (Cowan's working memory limit).

---

### 7. Dynamic threshold base 0.50, clamped [0.30, 0.70]

**Decision:** The confidence threshold for action selection is dynamic and modulated by drive state. Base threshold is 0.50 (middle of confidence range). The threshold is adjusted by: `threshold = 0.50 + (Anxiety * -0.10) + (Curiosity * +0.10) + (CognitiveLoad * +0.15)`, then clamped to [0.30, 0.70].

**Rationale (Cortex + Ashby):** High Anxiety lowers the threshold (system accepts lower-confidence Type 1 actions rather than attempting novel exploration). High Curiosity raises it (system tolerates risk-seeking exploration). High Cognitive Load (pressure from Cognitive Awareness drive) raises it (system defers to proven behaviors when overloaded). Clamping prevents pathological thresholds: if Anxiety alone reached 0.80, threshold would go negative (nonsensical). The [0.30, 0.70] bounds are conservative; even under max stress, some actions remain viable (0.30), and under max safety, not all actions are acceptable (0.70).

**Trade-off:** The formula coefficients are tuning parameters (-0.10 for Anxiety, +0.10 for Curiosity, +0.15 for Cognitive Load). If Anxiety coefficient is too high, the system becomes paralyzed (all actions below threshold). If Curiosity coefficient is too high, the system becomes reckless. These coefficients must be determined by Jim or emergent from Phase 1 testing. Mitigated by: (a) coefficients are logged, (b) Jim can adjust them, (c) CANON permits dynamic thresholds without specifying exact coefficients.

**Implementation detail:**

```typescript
// arbitration-threshold.service.ts
computeThreshold(driveState: DriveSnapshot): number {
  let threshold = 0.50;

  // Anxiety lowers threshold (risk-averse selection)
  threshold -= driveState.anxiety * 0.10;

  // Curiosity raises threshold (prefer exploration)
  threshold += driveState.curiosity * 0.10;

  // Cognitive Load raises threshold (prefer proven behaviors)
  const cognitiveLoad = driveState.cognitiveAwareness;
  threshold += cognitiveLoad * 0.15;

  // Clamp to [0.30, 0.70]
  return Math.max(0.30, Math.min(0.70, threshold));
}
```

**CANON alignment:** Core Philosophy 2 (Dynamic threshold). Behavioral Contingency Structure (Anxiety/Curiosity modulation).

---

### 8. Type 1 graduation state machine on WKG action nodes

**Decision:** Action nodes in the WKG carry a `type1State` field that tracks progression: UNCLASSIFIED → TYPE_2_ONLY → TYPE_1_CANDIDATE → TYPE_1_GRADUATED → TYPE_1_DEMOTED. Graduation requires: confidence > 0.80 AND MAE < 0.10 over last 10 uses. Demotion occurs if: MAE > 0.15 over 10 uses or confidence drops below 0.50.

**Rationale (Cortex + Atlas + CANON):** The CANON specifies Type 1/Type 2 discipline: "Everything starts as Type 2. Through successful repetition, behaviors graduate to Type 1." This decision codifies what "successful repetition" means: both high confidence (the system is sure this is right) AND low prediction error (the system's confidence is justified). Without both criteria, graduation creates false confidence (high confidence but wrong predictions).

**Trade-off:** Tracking state on WKG nodes adds a field to every action node. This is negligible storage cost but increases query complexity (must check state before retrieval). Mitigated by: (a) Type 1 nodes are indexed separately (faster retrieval for Type 1 candidates), (b) state transitions are lazy (evaluated on-demand, not on every tick).

**Implementation detail:**

```typescript
// action-retriever.service.ts
async retrieveActions(
  context: ActionContext,
  limit: number = 3
): Promise<Prediction[]> {
  // Query Type 1 GRADUATED actions first
  const type1Actions = await this.wkgService.query(`
    MATCH (a:Action {type1State: 'TYPE_1_GRADUATED'})
    WHERE fingerprint(context) = a.contextFingerprint
    RETURN a
    LIMIT ${limit}
  `);

  if (type1Actions.length < limit) {
    // Fallback to TYPE_1_CANDIDATE
    const candidates = await this.wkgService.query(`
      MATCH (a:Action {type1State: 'TYPE_1_CANDIDATE'})
      WHERE fingerprint(context) = a.contextFingerprint
      RETURN a
      LIMIT ${limit - type1Actions.length}
    `);
    return [...type1Actions, ...candidates];
  }

  return type1Actions;
}
```

**CANON alignment:** Type 1/Type 2 Discipline (Immutable Standard 3 — Confidence Ceiling requires both confidence and accuracy).

---

### 9. 3-path confidence updater with outcome classification

**Decision:** Confidence updates follow three pathways depending on outcome classification: (1) Counter-indicated (action produced opposite of desired effect) → confidence -0.10 (or -0.15 under high Anxiety). (2) No significant relief (action did not relieve drive) → confidence -0.01. (3) Reinforced (action produced expected relief) → ACT-R formula: `new_conf = min(1.0, base + 0.12 * ln(count) - decay * ln(hours + 1))`.

**Rationale (Cortex + Skinner + v1 lift):** This is a direct v1 lift with modifications. Path 1 (counter-indicated) detects dangerous predictions: actions that make things worse get hit hard. Path 2 (null effect) detects useless predictions: actions that don't help but don't hurt get gentle correction. Path 3 (reinforced) follows ACT-R dynamics for positive learning: each repetition provides diminishing returns (logarithmic), and old memories decay with time.

**Trade-off:** Three-path logic is complex and requires precise outcome classification. Mitigated by: (a) outcome classification happens in Drive Engine (E4), which has detailed behavioral contingency rules, (b) Decision Making just reads outcome classification and applies the corresponding update, (c) edge cases (ambiguous outcomes) are logged for guardian review.

**Implementation detail:**

```typescript
// confidence-updater.service.ts
async updateConfidence(
  action: Action,
  outcome: Outcome,
  driveState: DriveSnapshot
): Promise<ConfidenceUpdate> {
  const path = classifyOutcome(outcome); // From Drive Engine

  switch (path) {
    case 'COUNTER_INDICATED':
      let reduction = 0.10;
      if (driveState.anxiety > 0.7) reduction *= 1.5; // Anxiety amplification
      return {
        confidence: action.confidence - reduction,
        reason: 'Action made situation worse',
      };

    case 'NO_RELIEF':
      return {
        confidence: action.confidence - 0.01,
        reason: 'Action did not produce expected relief',
      };

    case 'REINFORCED':
      const count = await this.countSuccessfulUses(action.id);
      const age = await this.getAgeInHours(action.id);
      const newConf = Math.min(
        1.0,
        action.baseConfidence +
          0.12 * Math.log(count) -
          0.05 * Math.log(age + 1)
      );
      return {
        confidence: newConf,
        reason: 'Action reinforced; ACT-R update',
      };
  }
}
```

**CANON alignment:** Contingency Requirement (Immutable Standard 2). Confidence Ceiling (Immutable Standard 3).

---

### 10. Prediction MAE over sliding window of 10

**Decision:** For each action in each context, Decision Making computes Mean Absolute Error (MAE) as the average of `|predicted_drive_relief - actual_drive_relief|` over the last 10 predictions of that action in that context. This MAE feeds Type 1 graduation logic (graduation requires MAE < 0.10) and demotion logic (demotion if MAE > 0.15).

**Rationale (Cortex + Ashby + v1 lift):** Confidence is subjective (the system's belief in itself); MAE is objective (reality-based error). An action can be high-confidence but inaccurate (false confidence). By requiring MAE < 0.10, we ensure Type 1 behaviors are not just confident but also predictively accurate. The sliding window of 10 prevents graduation on lucky streaks (if the action succeeded 10 times in a row, MAE = 0.0 and graduation happens; if it then fails, demotion is triggered). This is healthy dynamics: the system learns to doubt luck.

**Trade-off:** Computing MAE requires storing predictions and outcomes in TimescaleDB and querying on every action use. This adds latency to OBSERVING state (~10ms per action). Mitigated by: (a) queries are indexed (fast), (b) MAE computation is lazy (only when needed, not every tick), (c) cache recent MAE values in-memory to avoid repeated queries.

**Implementation detail:**

```typescript
// prediction-evaluator.service.ts
async computeMAE(
  actionId: string,
  contextFingerprint: string,
  windowSize: number = 10
): Promise<number> {
  const predictions = await this.eventService.query(`
    SELECT predicted_relief, actual_relief FROM predictions
    WHERE action_id = $1 AND context_fingerprint = $2
    ORDER BY timestamp DESC
    LIMIT $3
  `, [actionId, contextFingerprint, windowSize]);

  if (predictions.length === 0) return 1.0; // No data: assume inaccurate

  const mae = predictions.reduce(
    (sum, p) => sum + Math.abs(p.predicted_relief - p.actual_relief),
    0
  ) / predictions.length;

  return mae;
}
```

**CANON alignment:** Immutable Standard 3 (Confidence Ceiling). Type 1/Type 2 Discipline.

---

### 11. Shrug as explicit action with dedicated handler

**Decision:** When no action candidate exceeds the dynamic threshold during ARBITRATING, the system does not select a low-confidence action. Instead, it selects SHRUG (a special action representing "I don't know"). SHRUG has a dedicated handler: emit "I don't know / I'm uncertain" intent to Communication, log the event to TimescaleDB with high salience (incomprehension is noteworthy), and encode the episode at HIGH encoding depth (learning-relevant moments should be remembered in detail).

**Rationale (Cortex + CANON):** The Shrug Imperative (Immutable Standard 4) states: "When nothing is above threshold, signal incomprehension. No random low-confidence actions." This prevents theater (pretending to know when uncertain) and creates honest behavior. It also produces learning opportunities: if the system shrugs, the guardian can correct, providing high-value learning.

**Trade-off:** Adding SHRUG as an action means Decision Making sometimes produces no actual output (no motor command, just a communication intent). This might feel like failure to external observers. Mitigated by: (a) SHRUG is honest and creates engagement (guardian responds), (b) shrugs drive curiosity and planning (E5 creates opportunities to learn), (c) as Type 1 graduates, shrugs should decrease naturally.

**Implementation detail:**

```typescript
// arbitration.service.ts
selectAction(
  candidates: Prediction[],
  threshold: number
): ArbitrationCandidate {
  const above = candidates.filter(c => c.confidence > threshold);

  if (above.length === 0) {
    // Shrug: explicit incomprehension
    return {
      actionId: 'SHRUG',
      actionType: 'COMMUNICATION',
      confidence: 0.0,
      reason: 'No candidates above threshold',
    };
  }

  // Rank by confidence, break ties by salience
  above.sort((a, b) => {
    if (b.confidence !== a.confidence) {
      return b.confidence - a.confidence;
    }
    return (b.salience || 0) - (a.salience || 0);
  });

  return above[0];
}

// executor-engine.service.ts
private handleShrug(context: ExecutorContext): void {
  const intent = {
    type: 'COMMUNICATION',
    content: "I'm not sure how to respond to that.",
    reason: 'No action above confidence threshold',
  };

  this.communicationService.emit(intent);

  // Log with high salience
  this.eventService.record({
    type: 'SHRUG',
    cycleId: context.cycleId,
    salience: 0.95,
    context: context,
  });
}
```

**CANON alignment:** Immutable Standard 4 (Shrug Imperative).

---

### 12. Context fingerprint hashing for O(1) Type 1 lookup

**Decision:** The action context (drive category, recent episodic state, WKG query constraints) is hashed into a deterministic fingerprint (32-char hex string). Action nodes are indexed by this fingerprint. Type 1 candidate retrieval queries the index using the fingerprint, avoiding a full-graph scan.

**Rationale (Cortex + Atlas):** Type 1 must be faster than Type 2, or the system never uses Type 1. A full WKG query (MATCH (a:Action) WHERE ...) is O(|actions|) and becomes prohibitively slow as the graph grows. Fingerprint hashing reduces retrieval to O(1) index lookup. The fingerprint must be deterministic (same context = same hash) so that repeated decision cycles retrieve the same action candidates.

**Trade-off:** Fingerprinting requires accurate context definition and collision-resistant hashing. Also, if the context definition changes, old fingerprints become stale. Mitigated by: (a) context definition is frozen at startup (specified in config), (b) fingerprint collisions are detected and logged (action retrieval returns multiple candidates), (c) fallback to full-graph query if index is corrupted.

**Implementation detail:**

```typescript
// action-retriever.service.ts
private computeFingerprint(context: ActionContext): string {
  const key = `${context.driveCategory}|${context.attention}|${context.arousal}`;
  return crypto
    .createHash('sha256')
    .update(key)
    .digest('hex')
    .substring(0, 32);
}

async retrieveActions(context: ActionContext): Promise<Prediction[]> {
  const fingerprint = this.computeFingerprint(context);

  // O(1) index lookup
  const actions = await this.wkgService.queryByIndex(
    'action_fingerprint_idx',
    fingerprint
  );

  return actions.map(a => new Prediction(a));
}
```

**CANON alignment:** Performance requirement (Type 1 must be faster than Type 2). Architectural efficiency (O(1) retrieval).

---

### 13. Guardian Asymmetry in confidence updates

**Decision:** When a guardian confirms a prediction (e.g., "Yes, that's correct"), the action's confidence receives a 2x weight bonus: the encounter count is incremented by 2 instead of 1, inflating the numerator in the ACT-R formula. When a guardian corrects a prediction (e.g., "No, that's wrong"), the confidence reduction is 3x normal: instead of -0.10, it becomes -0.30.

**Rationale (Cortex + CANON + v1 lift):** The CANON specifies Guardian Asymmetry as 2x/3x weighting (Immutable Standard 5). This reflects the fact that guardian feedback is higher-signal than algorithmic feedback: the guardian has a richer model than the system has. A single guardian confirmation is worth ~2 algorithmic confirmations. A single correction is worth ~3 algorithmic errors (because it indicates a systematic misunderstanding, not random noise).

**Trade-off:** Guardian Asymmetry requires reliable guardian-feedback detection (Communication must recognize "yes" vs. "no" vs. neutral). This adds latency to Learning cycles. Mitigated by: (a) guardian feedback is detected via simple keyword matching initially ("yes", "correct", "wrong", "no"), (b) feedback detection is logged and guardians can correct the system, (c) feedback is optional (if undetected, normal weighting applies).

**Implementation detail:**

```typescript
// confidence-updater.service.ts
async updateConfidence(
  action: Action,
  outcome: Outcome,
  guardianFeedback?: GuardianFeedback
): Promise<ConfidenceUpdate> {
  const baseUpdate = this.computeBaseUpdate(outcome);

  if (guardianFeedback?.type === 'CONFIRMATION') {
    // 2x weight: increment counter by 2
    const count = (await this.countUses(action.id)) + 1; // +1 from current
    const adjustedCount = count * 2; // 2x weight
    const newConf = Math.min(
      1.0,
      action.baseConfidence + 0.12 * Math.log(adjustedCount) - ...
    );
    return { confidence: newConf, reason: 'Guardian confirmed; 2x weighting' };
  }

  if (guardianFeedback?.type === 'CORRECTION') {
    // 3x weight: triple the reduction
    const reduction = baseUpdate.confidence < 0
      ? baseUpdate.confidence * 3
      : baseUpdate.confidence;
    return { confidence: action.confidence + reduction, reason: 'Guardian corrected; 3x penalty' };
  }

  // No guardian feedback: normal update
  return baseUpdate;
}
```

**CANON alignment:** Immutable Standard 5 (Guardian Asymmetry).

---

### 14. Anxiety amplification (1.5x) on confidence reduction

**Decision:** When Anxiety > 0.7 and an action produces a negative outcome (counter-indicated path), the confidence reduction is multiplied by 1.5. Normal reduction on negative outcome is -0.10; under high anxiety, it becomes -0.15.

**Rationale (Cortex + Skinner + Behavioral Contingency):** This is severity-dependent punishment. Under stress, failures are more informative than under calm conditions: if you try something novel and it fails while anxious, you learn "don't do that under stress." This shapes cautious-but-active behavior: the system avoids risky exploration when anxious, but doesn't freeze entirely.

**Behavioral prediction:**
- Anxiety < 0.7: System explores freely, normal confidence reductions (-0.10) on failure
- Anxiety > 0.7: System preferentially selects high-confidence Type 1 behaviors, novel actions (Type 2) carry amplified penalty (-0.15)
- Chronic high anxiety without relief mechanisms: System converges on small set of proven behaviors (Depressive Attractor path)

**Trade-off:** The exact amplification factor (1.5x) is a tuning parameter. Too low (1.1x) and anxiety doesn't deter risky exploration; too high (2.0x+) and it over-penalizes. 1.5x is conservative. Mitigated by: (a) Jim can adjust the factor, (b) the effect emerges naturally if calibrated well (should not require frequent tuning).

**Implementation detail:**

```typescript
// confidence-updater.service.ts
case 'COUNTER_INDICATED':
  let reduction = 0.10;

  // Anxiety amplification: 1.5x under high stress
  if (driveState.anxiety > 0.7) {
    reduction *= 1.5; // -0.10 becomes -0.15
  }

  return {
    confidence: action.confidence - reduction,
    reason: `Prediction failed; ${driveState.anxiety > 0.7 ? 'anxiety-amplified' : 'normal'} reduction`,
  };
```

**CANON alignment:** Behavioral Contingency Structure (Anxiety Amplification). Skinner's severity-dependent punishment.

---

### 15. Cold-start awareness and honest prediction

**Decision:** During early sessions (sparse WKG, few learned patterns), the system produces mostly Type 2 (LLM-mediated) decisions and frequent shrugs. E5 does not artificially boost Type 1 confidence or prioritize graduated actions before they're ready. Cold-start dampening (E4 responsibility) prevents the Planning subsystem from creating procedures too early, but E5 honestly reports prediction accuracy without inflation. If the WKG is sparse, Type 1 is rare; shrugs are common.

**Rationale (Cortex + Piaget + CANON):** Piaget's developmental theory emphasizes that learning progresses through stages; you cannot skip stages by providing external motivation. Similarly, Sylphie cannot skip Type 1 development by artificial confidence boosting. The system must earn Type 1 through successful predictions. Early sessions are the "sensorimotor" stage: the system is exploring, building the graph, and learning what works. Honesty about this process is critical.

**Trade-off:** Early sessions will feel "dumb" — many shrugs, slow decision-making, frequent LLM invocations. This is not a bug; it's healthy development. Mitigated by: (a) Jim understands this is cold-start phase, (b) each session moves toward Type 1 graduation as the graph grows, (c) personality emerges naturally as patterns are learned.

**Implementation detail:**

```typescript
// arbitration.service.ts
selectAction(candidates: Prediction[], threshold: number): ArbitrationCandidate {
  // NO artificial boost based on session count
  // NO dampening of confidence for cold-start
  // Just honest comparison against threshold

  const above = candidates.filter(c => c.confidence > threshold);

  if (above.length === 0) {
    return { actionId: 'SHRUG', confidence: 0.0 };
  }

  // Select highest confidence, without any special cold-start handling
  return above.sort((a, b) => b.confidence - a.confidence)[0];
}
```

**CANON alignment:** No artificial guarantees. Immutable Standard 4 (Shrug Imperative) combined with Piaget's developmental stage theory.

---

## Decisions Requiring Jim

These six decisions must be resolved before E5 implementation begins:

### 1. Theater Prohibition enforcement in E5

**Issue:** The Theater Prohibition (Immutable Standard 1) states: "Output must correlate with actual drive state. No performing emotions she doesn't have." The question is: should E5 (Decision Making) enforce this proactively, or should E6 (Communication) be responsible?

**Option A (E5 proactive):** Before passing an action intent to Communication, E5 checks: "Does this action express emotion? If pressure/distress, is drive > 0.20? If relief/contentment, is drive < 0.30?" If not, E5 does not pass the intent to Communication.

**Option B (E6 responsibility):** E5 passes all action intents to Communication. Communication checks drive state and refuses to voice intents that violate the directional Theater rules (pressure expression requires drive > 0.20; relief expression requires drive < 0.30).

**Option C (Both):** E5 does basic checks (obvious inconsistencies). E6 does detailed checks (nuanced emotional expression analysis).

**Rationale:** Option A is simpler for E5 but requires E5 to know about emotional expressions (domain knowledge). Option B is cleaner (E6 owns output generation) but requires E6 to reject E5's intents (creates loops). Option C provides defense-in-depth.

**Recommendation:** Option C (both check). E5 checks obvious cases (e.g., "express joy/contentment" when satisfaction >= 0.30, or "express distress" when drive <= 0.20); E6 checks subtle cases (tone, word choice).

**Decision needed:** Where should Theater Prohibition enforcement happen — E5 proactive check, E6 validation, or both?

**Status:** APPROVED (2026-03-29) — Option C (both E5 and E6 check). Updated to directional check.

---

### 2. Guardian Asymmetry application in arbitration ranking

**Issue:** E5 Decision 13 applies Guardian Asymmetry (2x/3x) to confidence updates in the OBSERVING state. But should Guardian Asymmetry also affect action candidate ranking during ARBITRATING?

**Option A:** No. Asymmetry applies only to post-hoc confidence updates. During ARBITRATING, all candidates compete fairly by current confidence.

**Option B:** Yes. Actions that have been guardian-confirmed should get a ranking bonus (e.g., sorted first among equal-confidence candidates).

**Option C:** Guardian-confirmed actions should be marked and separated from algorithmic candidates, with confirmed actions always winning in case of ties.

**Rationale:** Option A keeps arbitration simple and fair. Option B gives guardian feedback real-time influence (faster). Option C is closest to "guardian feedback outweighs algorithmic evaluation" language in the CANON.

**Recommendation:** Option C (guardian-confirmed actions win ties). This makes guardian feedback immediately actionable.

**Decision needed:** Should Guardian Asymmetry affect action ranking during ARBITRATING? (No / yes as tiebreaker / yes with separation / other?)

**Status:** APPROVED (2026-03-29) — Option C (guardian-confirmed actions win ties)

---

### 3. Idle tick rate and configurability

**Issue:** E5 Decision 1 specifies a 5Hz idle tick (every 200ms) for autonomous action initiation. Is 5Hz appropriate, or should it be configurable? What is the rationale for this specific frequency?

**Options:**
- **1Hz (1s tick):** Very slow, minimal resource use, but Boredom responses feel sluggish
- **5Hz (200ms tick):** Proposed; balances responsiveness with resource use
- **10Hz (100ms tick):** Faster responsiveness, higher resource use
- **Configurable:** Start at 5Hz, allow Jim to adjust based on Phase 1 observations

**Trade-off:**
- Too slow (1Hz): System takes a full second to respond to Boredom, feels dead
- Too fast (50Hz): Excessive CPU load, high noise in decision-making
- Configurable: Adds complexity but allows tuning

**Recommendation:** Start with 5Hz (200ms), make it configurable via environment variable or config file.

**Decision needed:** What idle tick rate? (1Hz / 5Hz / 10Hz / configurable?) And why that specific frequency?

**Status:** APPROVED (2026-03-29) — 5Hz (200ms), configurable via environment variable

---

### 4. SHRUG output formatting and guardian engagement

**Issue:** E5 Decision 11 specifies that SHRUG produces a "I don't know" communication. But how exactly should this be formatted, and how should it engage the guardian?

**Options:**
1. **Simple acknowledgment:** "I'm uncertain" (minimal output)
2. **Diagnostic output:** "I don't know how to respond to [X]; my options were [list candidates <0.50]" (informative)
3. **Query output:** "I'm uncertain. Could you explain what you mean?" (Socratic engagement)
4. **Silent internal flag:** Record SHRUG internally but don't communicate (no output)

**Trade-off:**
- Option 1: Minimal but honest
- Option 2: Helps Jim debug
- Option 3: Engages guardian, creates learning opportunity
- Option 4: No engagement, silent failure

**Recommendation:** Option 3 (Query output). SHRUG should be an opportunity for teaching. When Sylphie shrugs, the guardian responds with clarification, and Learning subsystem (E3) creates new edges.

**Decision needed:** How should SHRUG be formatted and communicated? (Simple / diagnostic / query / silent?)

**Status:** APPROVED (2026-03-29) — Option 3 (query output — Socratic engagement)

---

### 5. Sliding window size for MAE computation

**Issue:** E5 Decision 10 specifies a sliding window of 10 for MAE (Mean Absolute Error). Is 10 the right size? Too small and noise dominates; too large and old patterns persist too long.

**Options:**
- **Window = 5:** More responsive to recent performance, less stable
- **Window = 10:** Balanced (proposed)
- **Window = 20:** More stable, slower to detect degradation
- **Adaptive:** Window size depends on action frequency (fast actions: smaller window; rare actions: larger)

**Trade-off:**
- Small window: Reacts quickly to performance changes, but noisy
- Large window: Stable but slow to detect regressions
- Adaptive: Complex but potentially better calibrated

**Recommendation:** Fixed window = 10 to start. If E4's graduation logic is too fast or too slow, Jim can adjust.

**Decision needed:** What is the MAE sliding window size? (5 / 10 / 20 / adaptive?)

**Status:** APPROVED (2026-03-29) — Fixed window = 10

---

### 6. Encoding depth formula and gating thresholds

**Issue:** E5 Decision 4 specifies encoding gating as a product of attention and arousal, but the exact formula and thresholds are not specified.

**Formula proposed:** `product = attention * arousal` with thresholds:
- DEEP: product > 0.6
- NORMAL: product > 0.3
- SHALLOW: product > 0.1
- SKIP: product ≤ 0.1

**Questions:**
1. Should the formula be multiplicative (AND) or additive (weighted sum)?
2. Are the thresholds (0.6, 0.3, 0.1) correct?
3. Should System Health affect encoding depth (healthier system encodes more)?
4. Should drive salience boost encoding (high-drive events always encoded deeply)?

**Recommendation:** Keep multiplicative formula and thresholds as proposed. Add optional System Health boost (if health < 0.3, reduce encoding depth). Add drive salience bonus (if any drive > 0.8, boost encoding to DEEP).

**Decision needed:** What is the exact encoding depth formula and thresholds? (Multiplicative vs. additive? Threshold values? Modulation by health or salience?)

**Status:** APPROVED (2026-03-29) — Multiplicative formula, thresholds 0.6/0.3/0.1, with drive salience bonus

---

## Summary of Approved Decisions

**Approved by planning (no Jim input needed):**
1. Event-driven decision cycle with 5Hz idle tick
2. 8-state Executor Engine with explicit dual-process states
3. Episodic Memory as in-memory ring buffer with TimescaleDB backing
4. Encoding gating via attention/arousal product
5. 4-tier episode degradation with semantic consolidation
6. Max 5 Inner Monologue candidates with Cowan's limit
7. Dynamic threshold base 0.50, clamped [0.30, 0.70]
8. Type 1 graduation state machine on WKG action nodes
9. 3-path confidence updater with outcome classification
10. Prediction MAE over sliding window of 10
11. Shrug as explicit action with dedicated handler
12. Context fingerprint hashing for O(1) Type 1 lookup
13. Guardian Asymmetry in confidence updates
14. Anxiety amplification (1.5x) on confidence reduction
15. Cold-start awareness and honest prediction

**Approved by Jim (2026-03-29):**
1. Theater Prohibition enforcement in E5 — Option C (both E5 and E6 check), directional check
2. Guardian Asymmetry in arbitration ranking — Option C (guardian-confirmed actions win ties)
3. Idle tick rate — 5Hz (200ms), configurable via environment variable
4. SHRUG output formatting — Option 3 (query output, Socratic engagement)
5. MAE sliding window size — fixed window = 10
6. Encoding depth formula and thresholds — multiplicative, thresholds 0.6/0.3/0.1, with drive salience bonus
