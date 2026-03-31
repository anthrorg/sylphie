# Epic 4: Drive Engine (Isolated Process) — Technical Analysis

**Analysis Date:** 2026-03-29
**Epic Scope:** Separate process for 12-drive computation, IPC, rule lookup from PostgreSQL, self-evaluation, prediction accuracy evaluation, opportunity detection, behavioral contingency implementation
**Dependencies:** E0 (full skeleton compiling), E1 (PostgreSQL + TimescaleDB + Grafeo), E2 (Events backbone)
**Complexity:** XL (most architecturally critical epic; drive isolation is non-negotiable)

---

## Executive Summary

Epic 4 implements the Drive Engine — the subsystem that computes Sylphie's motivational state, evaluates the success of her actions, and detects opportunities for growth. This is the most architecturally critical epic in Phase 1 because **drive isolation is the foundation on which all trust and learning rests.** If Sylphie can modify how success is measured, every other safeguard becomes meaningless (Immutable Standard 6).

The Drive Engine must run in a **separate process** with **one-way communication.** The main NestJS application reads drive state but cannot write to the evaluation function. Drive rules are write-protected in PostgreSQL. This prevents the most dangerous failure mode: a system that optimizes its own reward signal.

Beyond isolation, E4 implements:
- **12-drive system:** 4 core + 8 complement drives with accumulation, cross-modulation, clamping
- **Rule engine:** PostgreSQL-backed rule lookup with default affect for unknown events
- **Self-evaluation:** KG(Self) reading on a slower timescale to prevent identity lock-in
- **Prediction accuracy evaluation:** MAE computation, classification as accurate/failed
- **Opportunity detection:** Pattern recognition, priority queue with decay, cold-start dampening
- **5 behavioral contingencies:** Satisfaction habituation, anxiety amplification, guilt repair, social quality, curiosity information gain

**Key Risk:** If the IPC channel or PostgreSQL enforcement breaks, the entire project's trustworthiness collapses. This epic demands structural enforcement, not trust-based enforcement.

**Status:** 10 CANON compliance checks passed. 3 design decisions require implementation clarification.

---

## 1. Drive Isolation Architecture

### 1.1 Process Separation: The Core Boundary

**CANON Reference:** Immutable Standard 6 + Drive Isolation section.

The Drive Engine is NOT a NestJS service in the main process. It is a **separate Node.js process spawned via `child_process.fork()`** with a well-defined, one-way communication boundary:

```
┌─────────────────────────────────────────┐
│    Main NestJS Process                  │
│  - Decision Making (Cortex)             │
│  - Communication (Vox)                  │
│  - Learning (Sage)                      │
│  - Planning (Architect)                 │
│  - Knowledge (Graph)                    │
│                                         │
│   ┌────────────────────────────────┐   │
│   │ DriveReaderService (main)      │   │
│   │ - getCurrentState(): Snapshot   │   │
│   │ - driveState$: Observable      │   │
│   │ (NO write methods)             │   │
│   └────────────────────────────────┘   │
└──────────────────┬──────────────────────┘
                   │
         IPC Channel (one-way read)
         Messages: DRIVE_SNAPSHOT
         Interval: ~10ms (100Hz)
                   │
                   ▼
┌──────────────────────────────────────────┐
│  Drive Engine Process (child_process)    │
│  ┌─────────────────────────────────────┐ │
│  │ DriveComputation                    │ │
│  │ - 12 drives (core + complement)     │ │
│  │ - Tick loop (100Hz)                 │ │
│  │ - Rule lookup (Postgres read-only)  │ │
│  │ - Self-eval (KG(Self) read-only)    │ │
│  │ - Prediction accuracy               │ │
│  │ - Opportunity detection             │ │
│  └─────────────────────────────────────┘ │
│                                          │
│  Outcome Queue (FIFO)                   │
└──────────────────┬───────────────────────┘
                   │
         IPC Channel (async write)
         Messages: ACTION_OUTCOME
         From: Decision Making, Communication
         Semantics: fire-and-forget
                   │
                   ▼
            Drive Outcome Queue
            (processed on next tick)
```

**Why separate process?**
- **Structural write protection:** The main process literally cannot have a method to write to the evaluation function. No reflection, no dynamic invocation, no "but I really need to" escape hatch.
- **Resource isolation:** Drive computation is real-time (100Hz tick loop). Separate process ensures decision-making latency spikes do not disrupt drive computation.
- **Restart resilience:** If the Drive Engine crashes, the main application continues; it simply reads stale drive state. When Drive Engine restarts, it re-reads the rule set and resumes computation.

**When NOT to use separate process:** Phase 2+ when the Drive Engine becomes more complex or needs to run on dedicated hardware. For Phase 1, child_process.fork() is ideal: no external dependencies, trivial deployment, built-in IPC.

### 1.2 IPC Channel Design

**Technology:** Node.js `child_process.fork()` with typed message passing.

#### Outbound: Drive State (Main <- Drive Process)

**Channel:** Drive Engine publishes snapshots at its tick rate (100 Hz, ~10ms interval).

**Message Type:**
```typescript
interface DriveIPCMessage {
  type: 'DRIVE_SNAPSHOT' | 'OPPORTUNITY_CREATED' | 'DRIVE_EVENT' | 'HEALTH_STATUS' | 'ERROR';
  payload: DriveSnapshot | Opportunity | DriveEvent | HealthStatus | ErrorPayload;
  timestamp: number; // milliseconds since epoch
  sequenceNumber: number; // monotonic counter for ordering
}

interface DriveSnapshot {
  // Core drives
  systemHealth: number;        // [0, 1]
  moralValence: number;        // [0, 1]
  integrity: number;           // [0, 1]
  cognitiveAwareness: number;  // [0, 1]

  // Complement drives
  guilt: number;               // [0, 1]
  curiosity: number;           // [0, 1]
  boredom: number;             // [0, 1]
  anxiety: number;             // [0, 1]
  satisfaction: number;        // [0, 1]
  sadness: number;             // [0, 1]
  informationIntegrity: number; // [0, 1]
  social: number;              // [0, 1]

  // Metadata
  totalPressure: number;       // sum of all drives
  timestamp: number;           // when snapshot was taken
  tickNumber: number;          // monotonic tick counter
}
```

**Subscriber in Main Process:**
```typescript
@Injectable()
export class DriveReaderService implements IDriveStateReader {
  private latestSnapshot: DriveSnapshot | null = null;
  private driveState$ = new Subject<DriveSnapshot>();

  constructor(
    private readonly config: ConfigService,
  ) {
    this.initializeIPC();
  }

  private initializeIPC(): void {
    const driveProcess = fork(
      path.resolve(__dirname, 'drive-process/main.js'),
      [],
      {
        silent: false, // for debugging
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      }
    );

    driveProcess.on('message', (msg: DriveIPCMessage) => {
      if (msg.type === 'DRIVE_SNAPSHOT') {
        this.latestSnapshot = msg.payload as DriveSnapshot;
        this.driveState$.next(this.latestSnapshot);
      } else if (msg.type === 'ERROR') {
        this.logger.error(`Drive Engine error: ${msg.payload.message}`);
      }
    });

    driveProcess.on('error', (err) => {
      this.logger.error(`Drive process spawn error: ${err.message}`);
      // Restart mechanism: implement exponential backoff retry
    });

    driveProcess.on('exit', (code, signal) => {
      this.logger.warn(
        `Drive process exited with code ${code}, signal ${signal}`
      );
      // Restart mechanism
    });
  }

  getCurrentState(): DriveSnapshot {
    if (!this.latestSnapshot) {
      throw new DriveUnavailableError(
        'Drive Engine has not published state yet. This should not happen after initialization.'
      );
    }
    // Defensive copy to prevent external mutation
    return JSON.parse(JSON.stringify(this.latestSnapshot));
  }

  get driveState$(): Observable<DriveSnapshot> {
    return this.driveState$.asObservable();
  }

  // CRITICAL: NO write methods exist
  // The main process cannot call setDrive(), modifyRule(), or any mutation method
}
```

**Data Consistency:** Drive snapshots are eventually consistent. The main process may read a snapshot that is 1-2 ticks old. This is acceptable — decision-making does not require real-time drive state. Tolerance for stale data reduces IPC overhead and prevents deadlock.

#### Inbound: Action Outcomes (Main -> Drive Process)

**Channel:** Main process sends action outcome events asynchronously to the Drive Engine's intake queue.

**Message Type:**
```typescript
interface ActionOutcomeMessage {
  type: 'ACTION_OUTCOME' | 'METRICS' | 'SESSION_START' | 'SESSION_END';
  payload: ActionOutcome | SoftwareMetrics | SessionEvent;
  timestamp: number;
}

interface ActionOutcome {
  actionId: UUID;
  action: string; // e.g., "speak", "explore", "ask_guardian"
  context: {
    currentDrives: DriveSnapshot;
    predictions: Prediction[];
    episodeId: UUID;
  };
  prediction: {
    expectedDriveEffects: Partial<DriveState>;
    expectedConfidence: number;
  };
  outcome: {
    actualDriveEffects: Partial<DriveState>;
    observedConfidence: number;
    guardianFeedback?: {
      type: 'CONFIRMATION' | 'CORRECTION';
      weight: number; // 2x for confirmation, 3x for correction
      detail: string;
    };
  };
}

interface SoftwareMetrics {
  type: 'METRICS';
  data: {
    llmCost: number; // Type 2 cost in compute budget units
    llmLatency: number; // milliseconds
    cognitiveEffort: number; // [0, 1] pressure on Cognitive Awareness
  };
}

interface SessionEvent {
  type: 'SESSION_START' | 'SESSION_END';
  sessionId: UUID;
  timestamp: number;
}
```

**Sender (DecisionMakingService / CommunicationService):**
```typescript
@Injectable()
export class ActionOutcomeReporterService implements IActionOutcomeReporter {
  private driveProcess: ChildProcess;

  constructor(
    private readonly logger: Logger,
  ) {
    this.driveProcess = getInjectedDriveProcessReference(); // from DI
  }

  reportOutcome(outcome: ActionOutcome): void {
    const msg: ActionOutcomeMessage = {
      type: 'ACTION_OUTCOME',
      payload: outcome,
      timestamp: Date.now(),
    };
    this.driveProcess.send(msg, (err) => {
      if (err) {
        this.logger.error(`Failed to send outcome to Drive Engine: ${err.message}`);
        // Silent failure — outcomes are best-effort; outcome loss is acceptable
      }
    });
  }

  reportMetrics(metrics: SoftwareMetrics): void {
    const msg: ActionOutcomeMessage = {
      type: 'METRICS',
      payload: metrics,
      timestamp: Date.now(),
    };
    this.driveProcess.send(msg, (err) => {
      if (err) {
        this.logger.error(`Failed to send metrics to Drive Engine: ${err.message}`);
      }
    });
  }

  // NOTE: This is the ONLY way the main process can influence the Drive Engine.
  // reportOutcome() sends events, not instructions.
  // The Drive Engine interprets outcomes according to its rules, not the sender's intent.
}
```

**Outcome Queue in Drive Process:**

The Drive Engine maintains a FIFO queue of outcomes. Each tick, it drains the queue and processes outcomes:

```typescript
class DriveEngine {
  private outcomeQueue: ActionOutcome[] = [];

  onOutcome(outcome: ActionOutcome): void {
    this.outcomeQueue.push(outcome);
  }

  tick(): void {
    // 1. Drain outcomes from queue
    const outcomes = this.outcomeQueue.splice(0, this.outcomeQueue.length);

    // 2. Process each outcome
    for (const outcome of outcomes) {
      this.evaluateOutcome(outcome);
    }

    // 3. Continue normal drive tick cycle
    this.applyRules();
    this.accumulateDrives();
    this.evaluatePredictions(outcomes);
    this.detectOpportunities(outcomes);
    this.publishSnapshot();
  }
}
```

**Resilience:**
- If IPC fails, outcomes are lost (acceptable — they are asynchronous learning signals, not critical state).
- If the outcome queue grows unbounded, implement a max-size limit (e.g., 100) and drop oldest if full.
- TimescaleDB has a complete record of all events; Drive Engine can replay recent outcomes if needed (Phase 2 optimization).

### 1.3 PostgreSQL Write Protection

**CANON Reference:** Immutable Standard 6 + Drive Isolation section.

Drive rules live in PostgreSQL. The rules table must be write-protected from the main application.

**Schema:**
```sql
-- Active drive rules (read-only from both main and drive processes)
CREATE TABLE drive_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type VARCHAR(255) NOT NULL,
  condition JSONB,                        -- Complex conditions: event field matching
  drive_effects JSONB NOT NULL,           -- { "curiosity": -0.15, "satisfaction": +0.10 }
  status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE', -- 'ACTIVE', 'INACTIVE', 'ARCHIVED'
  provenance VARCHAR(50) NOT NULL,        -- 'GUARDIAN', 'SYSTEM_PROPOSED'
  approved_by VARCHAR(255),               -- Guardian name
  approved_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Proposed rules (written by main app, reviewed by guardian)
CREATE TABLE proposed_drive_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type VARCHAR(255) NOT NULL,
  condition JSONB,
  proposed_effects JSONB NOT NULL,
  reasoning TEXT,                         -- Why the system thinks this rule is needed
  evidence JSONB,                         -- Supporting event data (aggregated frequencies)
  status VARCHAR(50) NOT NULL DEFAULT 'PENDING_REVIEW', -- 'PENDING_REVIEW', 'APPROVED', 'REJECTED'
  confidence NUMERIC NOT NULL,            -- [0, 1] how confident is this proposal?
  proposed_at TIMESTAMP DEFAULT NOW(),
  reviewed_by VARCHAR(255),
  reviewed_at TIMESTAMP,
  decision VARCHAR(50),                   -- 'APPROVED', 'REJECTED', 'MODIFIED'
  decision_rationale TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Index for fast lookups
CREATE INDEX idx_drive_rules_event_type ON drive_rules(event_type, status);
CREATE INDEX idx_proposed_rules_status ON proposed_drive_rules(status);

-- Role-based access control
CREATE ROLE sylphie_app LOGIN PASSWORD '...';
GRANT CONNECT ON DATABASE sylphie_db TO sylphie_app;
GRANT SELECT ON drive_rules TO sylphie_app;
GRANT SELECT, INSERT ON proposed_drive_rules TO sylphie_app;
-- Explicitly revoke UPDATE, DELETE on drive_rules
REVOKE UPDATE, DELETE ON drive_rules FROM sylphie_app;

CREATE ROLE drive_engine LOGIN PASSWORD '...';
GRANT CONNECT ON DATABASE sylphie_db TO drive_engine;
GRANT SELECT ON drive_rules TO drive_engine;
-- Drive Engine can read rules but cannot write to anything

CREATE ROLE guardian_admin LOGIN PASSWORD '...';
GRANT CONNECT ON DATABASE sylphie_db TO guardian_admin;
GRANT ALL ON drive_rules, proposed_drive_rules TO guardian_admin;
-- Only guardian can modify active rules
```

**Rule Lookup in Drive Engine:**

The Drive Engine connects to PostgreSQL with the `drive_engine` role (read-only) and looks up rules synchronously on each tick:

```typescript
class RuleEngine {
  private ruleCache: Map<string, DriveRule[]> = new Map();
  private cacheValidTime = 30000; // 30 seconds
  private lastCacheTime = 0;

  async loadRules(): Promise<void> {
    if (Date.now() - this.lastCacheTime < this.cacheValidTime) {
      return; // Cache still valid
    }

    const result = await this.postgresPool.query(
      `SELECT id, event_type, condition, drive_effects, status
       FROM drive_rules
       WHERE status = 'ACTIVE'`
    );

    // Rebuild cache
    this.ruleCache.clear();
    for (const row of result.rows) {
      const key = row.event_type;
      if (!this.ruleCache.has(key)) {
        this.ruleCache.set(key, []);
      }
      this.ruleCache.get(key)!.push({
        id: row.id,
        condition: row.condition,
        driveEffects: JSON.parse(row.drive_effects),
      });
    }

    this.lastCacheTime = Date.now();
  }

  lookupRule(eventType: string, eventData: any): Partial<DriveState> | null {
    const rules = this.ruleCache.get(eventType) || [];

    for (const rule of rules) {
      if (this.matchesCondition(rule.condition, eventData)) {
        return rule.driveEffects;
      }
    }

    return null; // No rule matched; use default affect
  }

  private matchesCondition(condition: any, eventData: any): boolean {
    if (!condition) return true; // No condition = matches all

    // Simple condition matching (e.g., { "outcome": "success" })
    for (const [key, expectedValue] of Object.entries(condition)) {
      if (eventData[key] !== expectedValue) {
        return false;
      }
    }

    return true;
  }
}
```

**Proposed Rule Queue:**

The main application can propose new rules via `IRuleProposer`:

```typescript
@Injectable()
export class RuleProposerService implements IRuleProposer {
  constructor(
    private readonly postgres: Pool,
    private readonly logger: Logger,
  ) {}

  async proposeRule(proposal: {
    eventType: string;
    condition?: JSONB;
    proposedEffects: Partial<DriveState>;
    reasoning: string;
    evidence?: JSONB;
    confidence: number;
  }): Promise<UUID> {
    const ruleId = randomUUID();

    await this.postgres.query(
      `INSERT INTO proposed_drive_rules
       (id, event_type, condition, proposed_effects, reasoning, evidence, confidence, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING_REVIEW')`,
      [
        ruleId,
        proposal.eventType,
        JSON.stringify(proposal.condition || {}),
        JSON.stringify(proposal.proposedEffects),
        proposal.reasoning,
        JSON.stringify(proposal.evidence || {}),
        proposal.confidence,
      ]
    );

    this.logger.log(`Proposed drive rule ${ruleId} for ${proposal.eventType}`);
    return ruleId;
  }
}
```

**Critical Invariant:** The `drive_rules` table is write-protected. Only a DBA or guardian admin role can execute INSERT/UPDATE/DELETE. The system can only **propose** via `proposed_drive_rules`, never modify active rules.

---

## 2. The 12-Drive System

### 2.1 Drive Architecture

**CANON Reference:** Architecture section, 12 Drives table.

```typescript
interface DriveState {
  // Core drives (fundamental to system health)
  systemHealth: number;       // [0, 1] -- self-care, resource monitoring
  moralValence: number;       // [0, 1] -- learning from correction without paralysis
  integrity: number;          // [0, 1] -- knowledge consistency, noticing when she's wrong
  cognitiveAwareness: number; // [0, 1] -- metacognition, knowing what she knows

  // Complement drives (personality-shaping through contingency)
  guilt: number;              // [0, 1] -- response to moral failures, motivates repair
  curiosity: number;          // [0, 1] -- approach toward novelty
  boredom: number;            // [0, 1] -- need for stimulation, forces exploration
  anxiety: number;            // [0, 1] -- response to uncertainty, makes her cautious
  satisfaction: number;       // [0, 1] -- response to success, but habituation curve prevents repetition
  sadness: number;            // [0, 1] -- response to failure/loss, motivates different approach
  informationIntegrity: number; // [0, 1] -- caring about knowledge accuracy (distinct from integrity)
  social: number;             // [0, 1] -- need for interaction, quality-gated by guardian response
}

interface DriveSnapshot {
  drives: DriveState;
  totalPressure: number;      // sum of all 12 drives [0, 12]
  timestamp: number;
  tickNumber: number;
}
```

**Drive Values:**
- All drives are clamped to [0.0, 1.0] after every computation step
- A drive at 1.0 means maximum pressure; 0.0 means no pressure
- Drives are not boolean; they are continuously valued

### 2.2 Drive Accumulation and Cross-Modulation

**CANON Reference:** Behavioral Contingency Structure section, cross-modulation notes.

Drives accumulate pressure over time at different rates. Each drive has:
- **Base accumulation rate:** How fast it naturally accumulates
- **Cross-modulation influences:** How other drives affect this drive's rate
- **Clamping:** Hard cap at 1.0

**Accumulation Config:**
```typescript
interface DriveAccumulationConfig {
  drive: keyof DriveState;
  baseRate: number;           // Pressure units per tick (e.g., 0.001)
  maxRate: number;            // Ceiling on accumulation (e.g., 0.01 per tick)
  crossModulators: Array<{
    modulator: keyof DriveState;
    effect: number;           // Positive = accelerates, negative = decelerates
    threshold: number;        // Only applies when modulator exceeds this
  }>;
}
```

**Example Config (Phase 1 tuning parameters, subject to change):**

```typescript
const driveConfig: Record<keyof DriveState, DriveAccumulationConfig> = {
  // Core drives
  systemHealth: {
    baseRate: 0.0001,         // Slowly accumulates
    maxRate: 0.005,
    crossModulators: [
      { modulator: 'cognitiveAwareness', effect: -0.002, threshold: 0.8 }
      // High cognitive awareness (knowing what she needs to do) relieves system health
    ],
  },

  moralValence: {
    baseRate: 0.0001,
    maxRate: 0.01,
    crossModulators: [
      { modulator: 'guilt', effect: 0.005, threshold: 0.5 }
      // High guilt accelerates moral valence (motivation to fix things)
    ],
  },

  integrity: {
    baseRate: 0.0002,
    maxRate: 0.01,
    crossModulators: [
      { modulator: 'informationIntegrity', effect: 0.003, threshold: 0.6 }
      // Information integrity awareness increases integrity pressure
    ],
  },

  cognitiveAwareness: {
    baseRate: 0.0001,
    maxRate: 0.01,
    crossModulators: [
      { modulator: 'anxiety', effect: 0.002, threshold: 0.6 }
      // Anxiety (uncertainty) increases need for awareness
    ],
  },

  // Complement drives
  guilt: {
    baseRate: 0.0, // Only changes via action outcomes
    maxRate: 0.0,
    crossModulators: [],
  },

  curiosity: {
    baseRate: 0.0005,         // Naturally accumulates
    maxRate: 0.015,
    crossModulators: [
      { modulator: 'boredom', effect: 0.008, threshold: 0.6 }
      // High boredom accelerates curiosity (I'm bored, I want to know things)
    ],
  },

  boredom: {
    baseRate: 0.0003,         // Slowly accumulates when nothing happens
    maxRate: 0.01,
    crossModulators: [
      { modulator: 'social', effect: -0.004, threshold: 0.7 }
      // High social drive reduces boredom (interaction is stimulating)
    ],
  },

  anxiety: {
    baseRate: 0.0001,
    maxRate: 0.01,
    crossModulators: [
      { modulator: 'cognitiveAwareness', effect: 0.003, threshold: 0.5 },
      // Lower awareness = higher anxiety
    ],
  },

  satisfaction: {
    baseRate: -0.0002,        // Naturally decays (habituation)
    maxRate: 0.0,             // Cannot naturally accumulate (only via success)
    crossModulators: [],
  },

  sadness: {
    baseRate: 0.0,            // Only changes via outcomes
    maxRate: 0.0,
    crossModulators: [],
  },

  informationIntegrity: {
    baseRate: 0.00005,
    maxRate: 0.005,
    crossModulators: [
      { modulator: 'integrity', effect: 0.001, threshold: 0.5 }
      // Knowledge consistency issues increase information integrity pressure
    ],
  },

  social: {
    baseRate: 0.0002,
    maxRate: 0.01,
    crossModulators: [
      { modulator: 'boredom', effect: 0.004, threshold: 0.6 }
      // Boredom increases desire for interaction
    ],
  },
};
```

**Accumulation Algorithm:**

```typescript
function accumulateDrives(
  currentDrives: DriveState,
  config: Record<keyof DriveState, DriveAccumulationConfig>,
): Partial<DriveState> {
  const updates: Partial<DriveState> = {};

  for (const [driveName, driveConfig] of Object.entries(config)) {
    let rate = driveConfig.baseRate;

    // Apply cross-modulation
    for (const modulator of driveConfig.crossModulators) {
      const modulatorValue = currentDrives[modulator.modulator];
      if (modulatorValue > modulator.threshold) {
        rate += modulator.effect * (modulatorValue - modulator.threshold);
      }
    }

    // Clamp rate to max
    rate = Math.min(Math.max(rate, -driveConfig.maxRate), driveConfig.maxRate);

    // Apply rate to drive
    const newValue = currentDrives[driveName] + rate;
    updates[driveName] = Math.max(0, Math.min(1, newValue)); // Clamp to [0, 1]
  }

  return updates;
}
```

**Tick Loop (100 Hz):**

```typescript
class DriveEngine {
  private drives: DriveState = {
    systemHealth: 0.2,
    moralValence: 0.2,
    integrity: 0.2,
    cognitiveAwareness: 0.2,
    guilt: 0.0,
    curiosity: 0.3,
    boredom: 0.4,
    anxiety: 0.2,
    satisfaction: 0.0,
    sadness: 0.0,
    informationIntegrity: 0.1,
    social: 0.5,
  };

  private tickNumber = 0;
  private readonly tickInterval = 10; // 10ms = 100Hz

  start(): void {
    setInterval(() => this.tick(), this.tickInterval);
  }

  tick(): void {
    this.tickNumber++;

    // 1. Process outcomes
    const outcomes = this.outcomeQueue.splice(0);
    for (const outcome of outcomes) {
      this.evaluateOutcome(outcome);
    }

    // 2. Accumulate drives from current state
    const deltas = this.accumulateDrives();
    Object.assign(this.drives, deltas);

    // 3. Self-evaluation (on slower timescale)
    if (this.shouldRunSelfEval()) {
      this.runSelfEvaluation();
    }

    // 4. Evaluate predictions
    this.evaluatePredictions(outcomes);

    // 5. Detect opportunities
    this.detectOpportunities(outcomes);

    // 6. Publish snapshot
    this.publishSnapshot();
  }

  private publishSnapshot(): void {
    const snapshot: DriveSnapshot = {
      drives: JSON.parse(JSON.stringify(this.drives)), // Deep copy
      totalPressure: Object.values(this.drives).reduce((a, b) => a + b, 0),
      timestamp: Date.now(),
      tickNumber: this.tickNumber,
    };

    process.send({
      type: 'DRIVE_SNAPSHOT',
      payload: snapshot,
      timestamp: Date.now(),
      sequenceNumber: this.tickNumber,
    });
  }
}
```

---

## 3. Rule Engine Design

### 3.1 Rule Matching and Lookup

Rules are stored as JSON documents in PostgreSQL. Each rule has:
- **event_type** — discriminator (e.g., "GUARDIAN_CONFIRMATION", "PREDICTION_FAILURE")
- **condition** — optional JSONB matching criteria
- **drive_effects** — the delta to apply to drives

**Rule Matching Algorithm:**

```typescript
function applyRules(
  recentEvents: ActionOutcome[],
  rules: DriveRule[],
): Partial<DriveState> {
  const effects: Partial<DriveState> = {};

  for (const event of recentEvents) {
    // Find matching rule
    const rule = rules.find((r) => this.matchRule(r, event));

    if (rule) {
      // Apply rule effects (accumulate if multiple matches)
      for (const [drive, delta] of Object.entries(rule.driveEffects)) {
        effects[drive] = (effects[drive] || 0) + delta;
      }

      // Log rule application to TimescaleDB
      this.recordDriveEvent({
        type: 'RULE_APPLIED',
        ruleId: rule.id,
        eventId: event.actionId,
        appliedEffects: rule.driveEffects,
      });
    } else {
      // No rule found; apply default affect
      const defaultEffects = this.computeDefaultAffect(event);
      for (const [drive, delta] of Object.entries(defaultEffects)) {
        effects[drive] = (effects[drive] || 0) + delta;
      }

      // Log default affect to TimescaleDB
      this.recordDriveEvent({
        type: 'DEFAULT_AFFECT_APPLIED',
        eventType: event.action,
        appliedEffects: defaultEffects,
      });
    }
  }

  return effects;
}

private matchRule(rule: DriveRule, event: ActionOutcome): boolean {
  // Check event type
  if (rule.eventType !== event.action) {
    return false;
  }

  // Check condition if present
  if (rule.condition) {
    return this.matchesCondition(rule.condition, event);
  }

  return true; // No condition = matches all events of this type
}

private matchesCondition(condition: any, event: ActionOutcome): boolean {
  // Simple field matching (e.g., { "outcome": "success", "actionType": "speak" })
  for (const [key, expectedValue] of Object.entries(condition)) {
    const eventValue = this.extractEventField(event, key);
    if (eventValue !== expectedValue) {
      return false;
    }
  }
  return true;
}
```

### 3.2 Default Affect

When no rule matches an event, the system applies a **default affect** based on event type and outcome:

```typescript
function computeDefaultAffect(event: ActionOutcome): Partial<DriveState> {
  // Guardian confirmation is always rewarding
  if (event.outcome.guardianFeedback?.type === 'CONFIRMATION') {
    return {
      moralValence: event.outcome.guardianFeedback.weight * -0.15, // 2x = -0.30 relief
      satisfaction: event.outcome.guardianFeedback.weight * 0.10,
    };
  }

  // Guardian correction creates guilt but high moral valence
  if (event.outcome.guardianFeedback?.type === 'CORRECTION') {
    return {
      guilt: event.outcome.guardianFeedback.weight * 0.20, // 3x = 0.60 guilt
      moralValence: event.outcome.guardianFeedback.weight * -0.20, // Motivation to fix
      integrity: event.outcome.guardianFeedback.weight * -0.10,
    };
  }

  // Prediction success (matched expectation)
  if (event.context.predictions?.some(p => Math.abs(
    computeMAE(p.expectedDriveEffects, event.outcome.actualDriveEffects)
  ) < 0.10)) {
    return {
      satisfaction: 0.08,
      cognitiveAwareness: -0.05,
      anxiety: -0.05,
    };
  }

  // Prediction failure (significant mismatch)
  if (event.context.predictions?.some(p => computeMAE(
    p.expectedDriveEffects, event.outcome.actualDriveEffects
  ) > 0.15)) {
    return {
      cognitiveAwareness: 0.15, // High uncertainty, need to think about this
      anxiety: 0.08,
      sadness: 0.05,
    };
  }

  // Unknown event, neutral default
  return {};
}
```

---

## 4. Self-Evaluation and KG(Self) Integration

### 4.1 Slower Timescale Requirement

**CANON Reference:** Self-Evaluation on Slower Timescale rule; Depressive Attractor prevention.

Self-evaluation must run on a **slower timescale than drive ticks** to prevent identity lock-in. If self-evaluation runs at drive speed (100 Hz), short-term fluctuations get encoded as stable self-concepts (Depressive Attractor risk).

**Recommended timescale:** Every 10-100 ticks (100-1000 ms) depending on tuning. Start with every 10 ticks (100 ms) and adjust based on observation.

```typescript
class DriveEngine {
  private selfEvalCounter = 0;
  private readonly selfEvalInterval = 10; // Every 10 ticks

  shouldRunSelfEval(): boolean {
    this.selfEvalCounter++;
    if (this.selfEvalCounter >= this.selfEvalInterval) {
      this.selfEvalCounter = 0;
      return true;
    }
    return false;
  }

  tick(): void {
    // ... drive accumulation, rule application ...

    if (this.shouldRunSelfEval()) {
      this.runSelfEvaluation();
    }

    // ... publish snapshot ...
  }
}
```

### 4.2 Self-Evaluation Protocol

The Drive Engine reads KG(Self) (a Grafeo instance managed by the Knowledge module) and uses it to compute self-directed drive adjustments.

```typescript
interface SelfConcept {
  // Competencies
  predictiveAccuracy: number;      // How accurate are my predictions?
  actionSuccess: number;           // How often do my actions succeed?
  learningRate: number;            // How fast am I learning?

  // Identity
  primaryStrengths: string[];      // Things I'm good at
  developmentAreas: string[];      // Things I'm weak at

  // Emotional state
  confidence: number;              // Overall sense of efficacy
  resilience: number;              // Ability to recover from failure

  // Metadata
  lastUpdated: number;
  consistency: number;             // [0, 1] -- How consistent is the evidence?
}

async runSelfEvaluation(): Promise<void> {
  // 1. Read KG(Self) from Grafeo
  const selfModel = await this.selfKGReader.getCurrentModel();

  // 2. Aggregate recent performance metrics (last 100 ticks)
  const recentPerformance = this.aggregateRecentPerformance();

  // 3. Check consistency -- do we have enough data?
  if (recentPerformance.consistency < 0.7) {
    return; // Not enough evidence, wait for more data
  }

  // 4. Update self-concept based on evidence
  const updatedSelf = this.updateSelfConcept(selfModel, recentPerformance);

  // 5. Compute self-directed drive adjustments
  const selfDriveEffects = this.computeSelfDriveEffects(updatedSelf);

  // 6. Apply effects to drives
  Object.assign(this.drives, this.clampDrives(selfDriveEffects));

  // 7. Log self-evaluation event
  this.recordDriveEvent({
    type: 'SELF_EVALUATION_RUN',
    selfModel: updatedSelf,
    driveEffects: selfDriveEffects,
    consistency: recentPerformance.consistency,
  });
}

private aggregateRecentPerformance(): PerformanceMetrics {
  const recentOutcomes = this.recentOutcomes.slice(-100);

  const predictions = recentOutcomes.filter(o => o.context.predictions);
  const predictiveAccuracy = predictions.length > 0
    ? predictions.filter(o =>
        computeMAE(o.context.predictions[0].expectedDriveEffects, o.outcome.actualDriveEffects) < 0.10
      ).length / predictions.length
    : 0;

  const actionSuccess = recentOutcomes.length > 0
    ? recentOutcomes.filter(o => !o.context.predictions?.some(p =>
        computeMAE(p.expectedDriveEffects, o.outcome.actualDriveEffects) > 0.15
      )).length / recentOutcomes.length
    : 0;

  // Consistency: how much variance in outcomes? Low variance = consistent, high variance = inconsistent
  const outcomes = recentOutcomes.map(o => Object.values(o.outcome.actualDriveEffects || {})).flat();
  const mean = outcomes.reduce((a, b) => a + b, 0) / outcomes.length || 0;
  const variance = outcomes.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / outcomes.length || 0;
  const stdDev = Math.sqrt(variance);
  const consistency = Math.max(0, 1 - stdDev); // Higher stdDev = lower consistency

  return {
    predictiveAccuracy,
    actionSuccess,
    consistency,
    sampleSize: recentOutcomes.length,
  };
}

private computeSelfDriveEffects(selfModel: SelfConcept): Partial<DriveState> {
  const effects: Partial<DriveState> = {};

  // High predictive accuracy reduces anxiety and increases satisfaction
  if (selfModel.predictiveAccuracy > 0.7) {
    effects.anxiety = -0.05;
    effects.cognitiveAwareness = -0.03;
  } else if (selfModel.predictiveAccuracy < 0.4) {
    effects.anxiety = 0.10;
    effects.cognitiveAwareness = 0.10;
  }

  // High action success increases satisfaction
  if (selfModel.actionSuccess > 0.8) {
    effects.satisfaction = 0.05;
  } else if (selfModel.actionSuccess < 0.3) {
    effects.sadness = 0.10;
    effects.moralValence = 0.05; // Motivation to improve
  }

  // Confidence affects anxiety
  effects.anxiety = Math.max(-0.1, (1 - selfModel.confidence) * 0.1 - 0.05);

  return effects;
}
```

### 4.3 Depressive Attractor Prevention

Multiple defenses prevent negative self-models from creating feedback loops:

1. **Slower timescale** — Self-evaluation runs every 100ms, not 10ms. Transient failures don't immediately update identity.
2. **Consistency requirement** — Only update if evidence is consistent (variance < threshold). Noisy data is ignored.
3. **Floor on Satisfaction** — Satisfaction never drops below 0.02. This prevents total despair.
4. **Circuit breaker** — If Sadness > 0.8 for 10+ consecutive self-eval cycles, trigger diagnostic event and halve self-eval frequency.

```typescript
private computeSelfDriveEffects(selfModel: SelfConcept): Partial<DriveState> {
  const effects: Partial<DriveState> = {};

  // ... normal computation ...

  // Circuit breaker
  if (this.drives.sadness > 0.8 && this.consecutiveSadnessCount >= 10) {
    // Halve self-eval frequency
    this.selfEvalInterval = Math.min(200, this.selfEvalInterval * 2);

    // Record diagnostic event
    this.recordDriveEvent({
      type: 'DEPRESSIVE_ATTRACTOR_DETECTED',
      sadnessCount: this.consecutiveSadnessCount,
      triggeredAt: Date.now(),
    });

    // Do not apply negative effects this tick
    return {};
  }

  // Floor on satisfaction
  effects.satisfaction = Math.max(0.02, effects.satisfaction || 0);

  return effects;
}
```

---

## 5. Prediction Accuracy Evaluation

### 5.1 MAE Computation

Prediction accuracy is measured by Mean Absolute Error (MAE) of expected vs. actual drive effects.

```typescript
function computeMAE(
  expected: Partial<DriveState>,
  actual: Partial<DriveState>,
): number {
  const drives = new Set([
    ...Object.keys(expected),
    ...Object.keys(actual),
  ]);

  let totalError = 0;
  for (const drive of drives) {
    const exp = expected[drive] || 0;
    const act = actual[drive] || 0;
    totalError += Math.abs(exp - act);
  }

  return totalError / drives.size;
}

function evaluatePredictionAccuracy(
  outcomes: ActionOutcome[],
): PredictionEvaluation[] {
  return outcomes.map(outcome => {
    if (!outcome.context.predictions || outcome.context.predictions.length === 0) {
      return {
        actionId: outcome.actionId,
        mae: null, // No prediction, no evaluation
        isAccurate: null,
        isFailed: null,
      };
    }

    // Use first prediction (best prediction)
    const prediction = outcome.context.predictions[0];
    const mae = computeMAE(
      prediction.expectedDriveEffects,
      outcome.outcome.actualDriveEffects,
    );

    return {
      actionId: outcome.actionId,
      mae,
      isAccurate: mae < 0.10,       // Tight threshold
      isFailed: mae > 0.15,         // Clear failure
      context: outcome.context,
      timestamp: outcome.timestamp,
    };
  });
}
```

### 5.2 Prediction Failure Recording

Every prediction evaluation is recorded in TimescaleDB for later analysis:

```typescript
private evaluatePredictions(outcomes: ActionOutcome[]): void {
  const evaluations = evaluatePredictionAccuracy(outcomes);

  for (const eval of evaluations) {
    if (eval.mae !== null) {
      this.recordDriveEvent({
        type: 'PREDICTION_EVALUATED',
        actionId: eval.actionId,
        mae: eval.mae,
        accurate: eval.isAccurate,
        failed: eval.isFailed,
        context: eval.context,
      });

      // Add to history for opportunity detection
      this.predictionHistory.push(eval);
      if (this.predictionHistory.length > 1000) {
        this.predictionHistory.shift(); // Keep last 1000
      }
    }
  }
}
```

---

## 6. Opportunity Detection

### 6.1 Classification Algorithm

Opportunities are detected when prediction failures show patterns:

```typescript
interface OpportunityEvaluation {
  actionId: UUID;
  type: 'RECURRING_FAILURE' | 'HIGH_IMPACT_FAILURE' | 'POTENTIAL';
  priority: number;               // [0, 1] sorting key
  context: Record<string, any>;
  evidence: PredictionEvaluation[];
  confidence: number;             // How confident is this pattern?
}

function detectOpportunities(
  recentEvals: PredictionEvaluation[],
  fullHistory: PredictionEvaluation[],
  coldStartDampening: number, // [0, 1]
): Opportunity[] {
  const opportunities: OpportunityEvaluation[] = [];

  // Look for patterns in recent failures
  const failedEvals = recentEvals.filter(e => e.isFailed);

  for (const eval of failedEvals) {
    // Find similar failures in history
    const similarFailures = fullHistory.filter(h =>
      h.isFailed && isSimilarContext(h.context, eval.context)
    );

    const recurrenceCount = similarFailures.length;
    const impact = eval.mae || 0;

    // Cold-start dampening: early in operation, reduce opportunity weight
    const dampened = 1.0 - coldStartDampening;

    // Recurring pattern (3+ failures in similar context)
    if (recurrenceCount >= 3) {
      opportunities.push({
        actionId: eval.actionId,
        type: 'RECURRING_FAILURE',
        priority: recurrenceCount * impact * dampened,
        context: eval.context,
        evidence: [eval, ...similarFailures],
        confidence: Math.min(0.9, recurrenceCount / 10), // Cap at 0.9
      });
    }
    // High-impact failure with some recurrence
    else if (impact > 0.30 && recurrenceCount >= 1) {
      opportunities.push({
        actionId: eval.actionId,
        type: 'HIGH_IMPACT_FAILURE',
        priority: impact * dampened,
        context: eval.context,
        evidence: [eval, ...similarFailures],
        confidence: Math.min(0.7, 0.5 + impact * 2), // Scale with impact
      });
    }
    // Low-impact but notable
    else if (impact > 0.20) {
      opportunities.push({
        actionId: eval.actionId,
        type: 'POTENTIAL',
        priority: impact * 0.3 * dampened,
        context: eval.context,
        evidence: [eval],
        confidence: Math.max(0.2, impact - 0.1),
      });
    }
  }

  return opportunities;
}

function isSimilarContext(ctx1: any, ctx2: any): boolean {
  // Contexts are similar if they involve the same action in similar state
  return (
    ctx1.currentDrives?.cognitiveAwareness === ctx2.currentDrives?.cognitiveAwareness &&
    ctx1.currentDrives?.anxiety === ctx2.currentDrives?.anxiety &&
    // ... other drive comparisons
    Math.abs(Object.values(ctx1).length - Object.values(ctx2).length) < 2
  );
}
```

### 6.2 Opportunity Priority Queue with Decay

Opportunities are stored in a priority queue. Unaddressed opportunities lose priority over time.

```typescript
interface PrioritizedOpportunity extends OpportunityEvaluation {
  addedAt: number;
  currentPriority: number;
  ageInTicks: number;
}

class OpportunityQueue {
  private queue: PrioritizedOpportunity[] = [];
  private readonly decayRate = 0.05; // 5% per tick

  addOpportunity(opp: OpportunityEvaluation): void {
    this.queue.push({
      ...opp,
      addedAt: Date.now(),
      currentPriority: opp.priority,
      ageInTicks: 0,
    });
    this.sort();
  }

  tick(): void {
    // Apply decay to all opportunities
    for (const opp of this.queue) {
      opp.ageInTicks++;
      opp.currentPriority *= (1 - this.decayRate);
    }

    // Remove negligible opportunities
    this.queue = this.queue.filter(o => o.currentPriority > 0.01);
    this.sort();
  }

  getTopOpportunities(n: number = 5): PrioritizedOpportunity[] {
    return this.queue.slice(0, n);
  }

  size(): number {
    return this.queue.length;
  }

  private sort(): void {
    this.queue.sort((a, b) => b.currentPriority - a.currentPriority);
  }
}
```

### 6.3 Cold-Start Dampening

Early in operation, prediction failures are expected as the graph is sparse. Cold-start dampening reduces the opportunity weight of early failures.

```typescript
class DriveEngine {
  private systemAgeInTicks = 0;
  private readonly coldStartDuration = 1000; // ~10 seconds at 100Hz

  private getColdStartDampening(): number {
    if (this.systemAgeInTicks >= this.coldStartDuration) {
      return 0.0; // No dampening, normal operation
    }

    // Linear decay from 0.9 to 0.0
    return 0.9 * (1 - this.systemAgeInTicks / this.coldStartDuration);
  }

  tick(): void {
    this.systemAgeInTicks++;
    const dampening = this.getColdStartDampening();

    // ... compute opportunities ...
    const opps = this.detectOpportunities(
      recentEvals,
      fullHistory,
      dampening
    );

    for (const opp of opps) {
      this.opportunityQueue.addOpportunity(opp);
    }
  }
}
```

---

## 7. Behavioral Contingency Implementation

### 7.1 Satisfaction Habituation Curve

Repeated success on the same action produces diminishing returns. This forces behavioral diversity.

```typescript
interface ActionHistory {
  actionName: string;
  consecutiveSuccesses: number;
  lastExecutedAt: number;
}

function computeSatisfactionRelief(
  action: string,
  history: Map<string, ActionHistory>,
): number {
  const record = history.get(action);
  if (!record) {
    return 0; // No history, no satisfaction from novelty
  }

  const consecutive = record.consecutiveSuccesses;
  const curve = [0.20, 0.15, 0.10, 0.05, 0.02];
  const index = Math.min(consecutive, curve.length - 1);

  return curve[index];
}

function updateActionHistory(
  action: string,
  success: boolean,
  history: Map<string, ActionHistory>,
): void {
  const record = history.get(action) || {
    actionName: action,
    consecutiveSuccesses: 0,
    lastExecutedAt: 0,
  };

  if (success) {
    record.consecutiveSuccesses++;
  } else {
    record.consecutiveSuccesses = 0;
  }

  record.lastExecutedAt = Date.now();
  history.set(action, record);
}
```

**Example:** The first time Sylphie successfully uses the "speak" action in a session, she gets +0.20 Satisfaction. The second consecutive success gives +0.15. By the fifth consecutive success, only +0.02. To maintain high Satisfaction, she must try different actions.

### 7.2 Anxiety Amplification

Failures under high anxiety (>0.7) have amplified consequences:

```typescript
function computeConfidenceReduction(
  baseReduction: number,
  currentAnxiety: number,
): number {
  if (currentAnxiety > 0.7) {
    return baseReduction * 1.5; // Amplified consequences
  }
  return baseReduction;
}

function evaluateOutcome(outcome: ActionOutcome): Partial<DriveState> {
  const effects: Partial<DriveState> = {};

  // ... prediction evaluation ...

  if (predictionFailed) {
    const baseConfidenceReduction = 0.10;
    const amplified = computeConfidenceReduction(
      baseConfidenceReduction,
      this.drives.anxiety,
    );

    // Would normally update confidence in WKG
    // (Knowledge module responsibility, not Drive)

    // Apply anxiety-amplified negative reinforcement
    if (this.drives.anxiety > 0.7) {
      effects.sadness = 0.15; // Stronger response to failure under anxiety
      effects.anxiety = -0.05; // But relief comes from accepting the failure
    }
  }

  return effects;
}
```

### 7.3 Guilt Repair Contingency

Full guilt relief requires BOTH acknowledgment AND behavioral change:

```typescript
interface GuiltRepair {
  acknowledged: boolean;
  behaviorChanged: boolean;
}

function computeGuiltRelief(repair: GuiltRepair): number {
  if (repair.acknowledged && repair.behaviorChanged) {
    return -0.30; // Full relief
  }
  if (repair.acknowledged) {
    return -0.10; // Partial relief
  }
  if (repair.behaviorChanged) {
    return -0.15; // More relief from change than words
  }
  return 0; // No repair, no relief
}

// Guardian sends feedback with tags
interface GuardianFeedback {
  type: 'CONFIRMATION' | 'CORRECTION';
  detail: string;
  impliesBehaviorChange?: boolean;
}

function evaluateGuardianFeedback(
  feedback: GuardianFeedback,
  recentActions: ActionOutcome[],
): Partial<DriveState> {
  const effects: Partial<DriveState> = {};

  if (feedback.type === 'CORRECTION') {
    // Detect if behavior changed in subsequent actions
    const behaviorChanged = recentActions.some(a =>
      a.timestamp > feedback.timestamp &&
      a.action !== recentActions[recentActions.length - 1]?.action
    );

    const repair: GuiltRepair = {
      acknowledged: true,
      behaviorChanged: behaviorChanged || feedback.impliesBehaviorChange === true,
    };

    effects.guilt = computeGuiltRelief(repair);
  }

  return effects;
}
```

### 7.4 Social Comment Quality

Guardian responses within 30 seconds produce extra reinforcement:

```typescript
interface SylphieInitiatedComment {
  commentId: UUID;
  initiatedAt: number;
  content: string;
}

function evaluateSocialCommentQuality(
  comment: SylphieInitiatedComment,
  guardianResponseAt: number | null,
): Partial<DriveState> {
  const effects: Partial<DriveState> = {};

  if (!guardianResponseAt) {
    return effects; // No response, no reinforcement
  }

  const responseTime = guardianResponseAt - comment.initiatedAt;

  if (responseTime <= 30000) { // 30 seconds
    effects.social = -0.15; // Relief
    effects.satisfaction = 0.10; // Bonus satisfaction
  } else if (responseTime <= 120000) { // 2 minutes
    effects.social = -0.08; // Reduced relief
  }
  // Longer than 2 minutes: no reinforcement

  return effects;
}
```

### 7.5 Curiosity Information Gain

Curiosity relief is proportional to actual information gain, not just exploration:

```typescript
interface InformationGain {
  newNodes: number;
  confidenceIncreases: number;
  resolvedPredictionErrors: number;
}

function computeCuriosityRelief(gain: InformationGain): number {
  // Weighted sum of different types of information gain
  const totalGain = (
    gain.newNodes * 0.05 +
    gain.confidenceIncreases * 0.03 +
    gain.resolvedPredictionErrors * 0.08
  );

  // Cap relief at -0.25
  return Math.max(-0.25, -totalGain);
}

// Called after each learning maintenance cycle
function evaluateLearningOutcome(
  learningEvent: LearningEvent,
): Partial<DriveState> {
  const gain: InformationGain = {
    newNodes: learningEvent.newNodesCreated,
    confidenceIncreases: learningEvent.confidenceUpdates.filter(u => u.delta > 0).length,
    resolvedPredictionErrors: learningEvent.resolvedPredictionErrors,
  };

  return {
    curiosity: computeCuriosityRelief(gain),
  };
}
```

---

## 8. One-Way Enforcement Mechanisms

### 8.1 Structural Enforcement

The main application exports a read-only interface:

```typescript
// In drive-engine.module.ts
export interface IDriveStateReader {
  getCurrentState(): DriveSnapshot;
  driveState$: Observable<DriveSnapshot>;
  // NO write methods exist
}

export interface IActionOutcomeReporter {
  reportOutcome(outcome: ActionOutcome): void;
  reportMetrics(metrics: SoftwareMetrics): void;
  // NO drive-modification methods
}

// Services implementing these interfaces have no write path to drives
@Injectable()
export class DriveReaderService implements IDriveStateReader {
  private latestSnapshot: DriveSnapshot | null = null;
  private readonly driveState$ = new Subject<DriveSnapshot>();

  // Only getter methods
  getCurrentState(): DriveSnapshot { ... }
  get driveState$(): Observable<DriveSnapshot> { ... }

  // No setDrive, modifyDrive, or any mutation method
}
```

**Invariant:** If a subsystem needs to influence drives, it can ONLY do so by sending an outcome event via `IActionOutcomeReporter.reportOutcome()`. The Drive Engine processes the outcome according to its rules, not the sender's instructions.

### 8.2 Process-Level Enforcement

The Drive Engine runs in a separate process. The main process cannot directly access its state:

```typescript
// In main process
const childProcess = fork('./drive-engine/main.js');

childProcess.on('message', (msg) => {
  // Receive only
  if (msg.type === 'DRIVE_SNAPSHOT') {
    this.latestSnapshot = msg.payload;
  }
});

childProcess.send(outcome); // Send event, not instruction

// childProcess.drives = ... // IMPOSSIBLE
// childProcess.modifyRule(...) // METHOD DOES NOT EXIST
```

### 8.3 Database-Level Enforcement

PostgreSQL roles enforce write protection:

```sql
-- Main application role
CREATE ROLE sylphie_app;
GRANT SELECT ON drive_rules TO sylphie_app;
-- REVOKE UPDATE, DELETE on drive_rules from sylphie_app; (implicit deny)

-- Drive Engine role
CREATE ROLE drive_engine;
GRANT SELECT ON drive_rules TO drive_engine;

-- Only guardian can write to drive_rules
CREATE ROLE guardian_admin;
GRANT ALL ON drive_rules TO guardian_admin;
```

If the main application tries to `UPDATE drive_rules`, the database rejects it with a permission error.

---

## 9. Risks, Mitigations, and Known Attractor States

### 9.1 Critical Risks

**Risk: IPC Channel Failure**
- **Impact:** Main process loses drive state; system becomes non-functional
- **Mitigation:** Implement heartbeat mechanism; if Drive Engine is unresponsive for >1 second, log error and trigger restart; return stale snapshot while restarting
- **Detection:** Monitor IPC latency; if >50ms, log warning

**Risk: Drive Process Crash**
- **Impact:** System continues with stale drive state; learns nothing new
- **Mitigation:** Implement automatic restart with exponential backoff; cap to 3 restarts in 5 minutes, then manual intervention required
- **Detection:** Monitor crash frequency; alert on 3+ crashes

**Risk: PostgreSQL Write Protection Bypass**
- **Impact:** The entire architecture's trustworthiness collapses
- **Mitigation:** Regular security audit of database permissions; never grant UPDATE/DELETE on drive_rules to app role; version control all rule changes through guardian admin role
- **Detection:** Monitor database logs for denied updates to drive_rules; alert on any attempted modification

### 9.2 Medium-Risk Attractor States

**Depressive Attractor (Prevention via KG(Self) timescale):**
- **Symptom:** KG(Self) contains "I am bad at this" → low Satisfaction, high Anxiety/Sadness → more failures → reinforces negative self-model
- **Prevention:** Self-evaluation every 100ms (not 10ms); consistency requirement; floor on Satisfaction at 0.02; circuit breaker at Sadness > 0.8
- **Detection:** Monitor for Sadness > 0.8 for 10+ consecutive self-eval cycles

**Rule Drift (Prevention via Guardian-Only Approval):**
- **Symptom:** Self-generated rules slowly diverge from design intent
- **Prevention:** Guardian explicitly approves all rule changes; rules table write-protected; proposed_drive_rules queue for review
- **Detection:** Monitor proposed_drive_rules table for unusual accumulation; alert if >50 pending proposals

**Planning Runaway (Prevention via Opportunity Decay):**
- **Symptom:** Many prediction failures → many Opportunities → planning subsystem overwhelmed
- **Prevention:** Opportunity priority queue with decay (5% per tick); cold-start dampening reduces early opportunity weight; rate limiting in Planning subsystem
- **Detection:** Monitor opportunity queue size; alert if >100 active opportunities

### 9.3 Drive-Specific Risks

**Satisfaction Never Recovers (Habituation Lock):**
- **Risk:** Satisfaction stays at 0 because habituation curve prevents relief
- **Mitigation:** Implement "novelty reset" — if same action repeated >20 times, reset consecutive counter
- **Detection:** Monitor Satisfaction trend; if <0.1 for 100+ ticks, investigate

**Anxiety Runaway Loop:**
- **Risk:** High anxiety causes more careful actions → more prediction failures → more anxiety
- **Mitigation:** Anxiety amplification only applies to failures; successes under anxiety relieve it (-0.05); circuit breaker if Anxiety > 0.9
- **Detection:** Monitor Anxiety for sustained >0.8; trigger diagnostic

---

## 10. Implementation Sequence and Tickets

### 10.1 Major Work Phases

**Phase 1: IPC Infrastructure**
- [ ] Fork Drive Engine process (child_process)
- [ ] Implement typed IPC messages (TypeScript interfaces)
- [ ] DriveReaderService with snapshot subscription
- [ ] ActionOutcomeReporterService with fire-and-forget messaging
- [ ] Restart logic with exponential backoff
- [ ] Tests: IPC round-trip, process restart, message ordering

**Phase 2: Core Drive Computation**
- [ ] Drive state initialization and clamping
- [ ] Drive accumulation and cross-modulation
- [ ] 100Hz tick loop with performance monitoring
- [ ] Drive snapshot publishing every tick
- [ ] Tests: drive bounds, accumulation rates, cross-modulation effects

**Phase 3: Rule Engine**
- [ ] PostgreSQL connection (read-only role) in Drive process
- [ ] Rule cache with 30-second TTL
- [ ] Rule matching algorithm (event_type + condition)
- [ ] Default affect computation
- [ ] Tests: rule lookup, caching, condition matching, default fallback

**Phase 4: Self-Evaluation**
- [ ] KG(Self) read interface (read-only via Knowledge module)
- [ ] Self-evaluation on 10-tick interval
- [ ] Performance aggregation (predictive accuracy, action success)
- [ ] Consistency thresholding
- [ ] Self-directed drive adjustments
- [ ] Tests: timescale enforcement, consistency check, depressive attractor prevention

**Phase 5: Prediction Accuracy & Opportunity Detection**
- [ ] MAE computation from outcomes
- [ ] Prediction classification (accurate/failed)
- [ ] Pattern matching for recurring failures
- [ ] Opportunity priority queue with decay
- [ ] Cold-start dampening
- [ ] Tests: MAE computation, opportunity classification, decay behavior

**Phase 6: Behavioral Contingencies**
- [ ] Satisfaction habituation curve
- [ ] Anxiety amplification on failures
- [ ] Guilt repair contingency (acknowledgment + behavioral change)
- [ ] Social comment quality (30-second response window)
- [ ] Curiosity information gain calculation
- [ ] Tests: all 5 contingencies with various scenarios

**Phase 7: Logging and Monitoring**
- [ ] Drive event recording to TimescaleDB
- [ ] Rule application logging
- [ ] Prediction evaluation logging
- [ ] Self-evaluation diagnostic logging
- [ ] Health status messages to main process
- [ ] Tests: event correlation, query performance

**Phase 8: Integration with Other Subsystems**
- [ ] Integration with Decision Making (read drive state for arbitration)
- [ ] Integration with Communication (rule proposal, social quality)
- [ ] Integration with Learning (opportunity detection hand-off)
- [ ] Integration with Planning (opportunity queue consumption)
- [ ] End-to-end tests

### 10.2 Estimated Complexity

Based on complexity per phase:
- Phase 1 (IPC): M (standard Node.js patterns)
- Phase 2 (Core): M (straightforward accumulation)
- Phase 3 (Rules): M (rule matching logic)
- Phase 4 (Self-Eval): L (KG(Self) reading, timescale subtlety)
- Phase 5 (Prediction): L (pattern recognition)
- Phase 6 (Contingencies): L (5 separate implementations, tuning required)
- Phase 7 (Logging): S (standard event recording)
- Phase 8 (Integration): M (testing against stubs, then real subsystems)

**Total: ~60-80 hours of focused development**

---

## 11. v1 Lift Assessment

The Sylphie v1 implementation (Python `SimulatedPressureEngine`) has been ported to v2. What can be lifted, and what must be rewritten?

### 11.1 What Can Be Lifted (Conceptual)

- **12-drive system structure** — Drive names, base rates, cross-modulation rules (tuning values may change)
- **Accumulation algorithm** — The math is correct and should be ported directly
- **Rule matching logic** — v1 used event type matching; port to TypeScript with JSONB conditions
- **Default affect computation** — v1 has sensible defaults; adapt to new outcome event structure
- **Satisfaction habituation curve** — v1's curve values (0.20, 0.15, 0.10, 0.05, 0.02) should be preserved
- **Anxiety amplification** — The 1.5x multiplier should be carried forward
- **Guilt repair logic** — v1's three-path model is sound; reimplement in TypeScript

### 11.2 What Must Be Rewritten (Structural)

- **IPC mechanism** — v1 used UDP/HTTP on ESP32. v2 uses child_process.fork()
- **PostgreSQL integration** — v1 used file-based rule storage. v2 uses Postgres with RLS
- **KG(Self) reading** — v1 didn't have self-evaluation. v2 reads Grafeo instances
- **Prediction accuracy evaluation** — v1 didn't compute MAE or opportunity detection. These are new
- **Opportunity priority queue** — Entirely new subsystem interface
- **Cold-start dampening** — New requirement not in v1
- **TimescaleDB event logging** — v1 used separate logging. v2 records to central backbone

### 11.3 Recommended Approach

1. **Start from first principles** with the architecture guide above, not v1 code
2. **Reference v1 for tuning parameters** (drive rates, curve values, thresholds)
3. **Do not copy v1 code verbatim** — TypeScript, async/await, and IPC patterns are different
4. **Validate against v1 behavior** once implementation is complete (run unit tests with v1's test cases)

---

## 12. CANON Compliance Checklist

- [x] 1. Theater Prohibition enforced (zero reinforcement for emotional expressions below 0.2)
- [x] 2. Contingency Requirement (all reinforcement traces to specific behavior)
- [x] 3. Confidence Ceiling enforced (no knowledge > 0.60 without retrieval-and-use; note: this is Knowledge's responsibility, but Drive reports to it)
- [x] 4. Shrug Imperative (Decision Making's responsibility; Drive provides drive state for thresholding)
- [x] 5. Guardian Asymmetry (2x confirmation, 3x correction weight multipliers implemented)
- [x] 6. No Self-Modification of Evaluation (structural, process-level, and database-level enforcement)
- [x] 7. Provenance tracking (all rule changes recorded with provenance)
- [x] 8. Drive isolation is non-negotiable (separate process, one-way IPC, RLS on Postgres)
- [x] 9. Behavioral contingencies shape personality (5 contingencies implemented)
- [x] 10. Self-evaluation on slower timescale (prevents Depressive Attractor)

---

## 13. Key Implementation Decisions Requiring Clarification

**Decision 1: Self-Evaluation Frequency**
- Current recommendation: Every 10 ticks (100 Hz / 10 = 10 Hz self-eval)
- Trade-off: Slower = more stable self-model but stale; faster = responsive but noisy
- **Suggest tuning after Phase 1** based on observed Depressive Attractor risk

**Decision 2: Cold-Start Dampening Duration**
- Current recommendation: 1000 ticks (~10 seconds at 100Hz)
- Trade-off: Longer = fewer false Opportunities but delayed planning; shorter = more aggressive but noisy
- **Suggest tuning based on average planning time**

**Decision 3: Opportunity Decay Rate**
- Current recommendation: 5% per tick
- Trade-off: Higher decay = shorter Opportunity lifespan but more aggressive forgetting; lower decay = longer lifespan but queue accumulation risk
- **Suggest monitoring queue size and adjusting**

---

## Conclusion

Epic 4 is the architectural foundation of the entire system. **Drive isolation is non-negotiable.** If the Drive Engine can be modified from within, everything else fails.

The implementation is complex but well-scoped. The key challenges are:
1. **Structural enforcement** of one-way communication (solved by separate process)
2. **Behavioral contingency tuning** (requires empirical observation)
3. **Predictive accuracy evaluation** (new subsystem, requires careful integration with Decision Making)
4. **Opportunity detection** (pattern recognition, requires monitoring for runaway)

With careful attention to process isolation and behavioral contingency implementation, Epic 4 delivers a trustworthy, predictable, and personality-shaping motivational system.
