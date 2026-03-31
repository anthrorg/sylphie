# Epic 4: Drive Engine (Isolated Process) — Forge Technical Architecture Analysis

**Author:** Forge (NestJS/TypeScript Systems Architect)
**Date:** 2026-03-29
**Complexity:** XL | **Dependencies:** E0, E1, E2

---

## 1. Executive Summary

Epic 4 builds the Drive Engine as a **separate Node.js process** with **one-way communication** to the main NestJS application. This is architecturally unique in the project: while all other subsystems run within the NestJS DI container, the Drive Engine runs in isolation, enforcing Immutable Standard 6 (No Self-Modification of Evaluation) at the process boundary.

The main NestJS app reads drive state via a read-only facade (DriveReaderService) and sends action outcomes via a fire-and-forget queue. The separate process computes drives, evaluates outcomes, and detects opportunities. Write-protection is enforced at three levels: structural (no write methods), process-level (separate process), and database-level (PostgreSQL RLS).

This document specifies the complete module structure, IPC architecture, service interfaces, configuration, and implementation strategy.

---

## 2. Architectural Overview

### 2.1 Process Topology

```
┌─────────────────────────────────┐
│   Main NestJS Process           │
│                                 │
│ ┌─────────────────────────────┐ │
│ │ DriveEngineModule           │ │
│ │                             │ │
│ │ ┌─────────────────────────┐ │ │
│ │ │ DriveReaderService      │ │ │
│ │ │ (IDriveStateReader)     │ │ │
│ │ │ - getCurrentState()     │ │ │
│ │ │ - driveState$           │ │ │
│ │ └─────────────────────────┘ │ │
│ │                             │ │
│ │ ┌─────────────────────────┐ │ │
│ │ │ ActionOutcomeReporter   │ │ │
│ │ │ (IActionOutcomeReporter)│ │ │
│ │ │ - reportOutcome()       │ │ │
│ │ └─────────────────────────┘ │ │
│ │                             │ │
│ │ ┌─────────────────────────┐ │ │
│ │ │ RuleProposerService     │ │ │
│ │ │ (IRuleProposer)         │ │ │
│ │ │ - proposeRule()         │ │ │
│ │ └─────────────────────────┘ │ │
│ │                             │ │
│ │ ┌─────────────────────────┐ │ │
│ │ │ IpcChannelService       │ │ │
│ │ │ (manages child_process) │ │ │
│ │ │ - fork()                │ │ │
│ │ │ - send()                │ │ │
│ │ │ - on('message')         │ │ │
│ │ └─────────────────────────┘ │ │
│ └─────────────────────────────┘ │
│                                 │
└─────────────────────────────────┘
         ↕ IPC (typed messages)
         ↕ One-way communication
┌─────────────────────────────────┐
│ Drive Engine Child Process      │
│ (separate Node.js process)      │
│                                 │
│ ┌─────────────────────────────┐ │
│ │ DriveProcessService         │ │
│ │                             │ │
│ │ - tick() @ 100Hz            │ │
│ │ - computeDrives()           │ │
│ │ - applyRules()              │ │
│ │ - evaluatePredictions()     │ │
│ │ - detectOpportunities()     │ │
│ │ - publishSnapshot()         │ │
│ │ - handleOutcome()           │ │
│ └─────────────────────────────┘ │
│                                 │
│ PostgreSQL (read-only)          │
│ + Grafeo/KG(Self) (read-only)   │
│ + TimescaleDB (write events)    │
│                                 │
└─────────────────────────────────┘
```

### 2.2 Communication Pattern

**Main → Child (Action Outcomes):**
- Fire-and-forget via `process.send()`
- Message types: `ACTION_OUTCOME`, `PREDICTION_RESULT`, `SESSION_START`, `SESSION_END`
- No response expected; child processes asynchronously
- Messages queued if child is temporarily unavailable

**Child → Main (Drive State):**
- Drive snapshots published on every tick via `process.send()`
- Main process caches latest snapshot in DriveReaderService
- Observable stream (`driveState$`) for reactive subscribers
- One-way: Main cannot write back to this channel

### 2.3 Write-Protection Enforcement

**Structural Level (TypeScript):**
- `IDriveStateReader` interface has no write methods
- DriveReaderService methods are read-only
- Consumers cannot call non-existent methods at compile time

**Process Level:**
- Child process runs independently with its own event loop
- No shared memory; communication via IPC only
- Main process has no file handle to child's state
- Child process can crash and restart; main process degrades gracefully

**Database Level (PostgreSQL):**
```sql
-- Main app role: read-only on active rules
CREATE ROLE sylphie_app LOGIN PASSWORD '...';
GRANT SELECT ON drive_rules TO sylphie_app;
-- No INSERT, UPDATE, DELETE on drive_rules

-- Proposed rules: main app can insert here
GRANT SELECT, INSERT ON proposed_drive_rules TO sylphie_app;

-- Drive engine child: read-only on active rules
CREATE ROLE drive_engine LOGIN PASSWORD '...';
GRANT SELECT ON drive_rules TO drive_engine;

-- Guardian admin: full control
CREATE ROLE guardian_admin LOGIN PASSWORD '...';
GRANT ALL ON drive_rules TO guardian_admin;
```

---

## 3. Module Structure: src/drive-engine/

```
src/drive-engine/
├── drive-engine.module.ts              # NestJS module declaration
├── drive-engine.service.ts             # Main facade (exports interfaces)
├── interfaces/
│   ├── drive-engine.interfaces.ts      # All public interfaces
│   ├── ipc.interfaces.ts               # IPC message types
│   └── rules.interfaces.ts             # Rule and opportunity types
├── drive-reader/
│   ├── drive-reader.service.ts         # IDriveStateReader implementation
│   ├── drive-state-snapshot.ts         # Snapshot caching & defensive copies
│   └── drive-reader.module.ts          # Module (exported from drive-engine)
├── action-outcome-reporter/
│   ├── action-outcome-reporter.service.ts  # IActionOutcomeReporter
│   └── outcome-queue.ts                # Fire-and-forget queueing
├── rule-proposer/
│   ├── rule-proposer.service.ts        # IRuleProposer implementation
│   └── postgres-rules-client.ts        # PostgreSQL write to proposed queue
├── ipc-channel/
│   ├── ipc-channel.service.ts          # child_process.fork() management
│   ├── message-handler.ts              # Inbound message processing
│   ├── health-monitor.ts               # Child process health checks
│   └── recovery.ts                     # Crash recovery & respawn logic
├── drive-process/
│   ├── main.ts                         # Entry point (separate process)
│   ├── drive-engine.ts                 # Core computation
│   ├── rule-engine.ts                  # Rule lookup & application
│   ├── self-evaluation.ts              # KG(Self) reads
│   ├── prediction-evaluator.ts         # Accuracy evaluation
│   ├── opportunity-detector.ts         # Failure pattern detection
│   ├── behavioral-contingencies.ts     # Relief functions
│   ├── accumulation.ts                 # Drive pressure accumulation
│   ├── cross-modulation.ts             # Drive cross-effects
│   ├── database-clients.ts             # PostgreSQL, Grafeo, TimescaleDB
│   └── config.ts                       # Process-specific config
├── exceptions/
│   ├── drive-engine.exception.ts       # DriveEngineException base
│   └── isolation-violation.exception.ts # DriveIsolationViolationError
├── config/
│   └── drive-engine.config.ts          # DriveEngineConfig schema
├── constants/
│   ├── drives.ts                       # Drive names, defaults, ranges
│   ├── confidence-dynamics.ts          # ACT-R parameters
│   └── contingencies.ts                # Satisfaction curve, anxiety, guilt, etc.
└── index.ts                            # Barrel export
```

---

## 4. Interface Contracts

### 4.1 DriveVector and Snapshots

```typescript
// src/drive-engine/interfaces/drive-engine.interfaces.ts

/**
 * The 12-drive state vector. Immutable from the perspective of consumers.
 * All values are normalized to [0.0, 1.0].
 * See CANON §Subsystem 4 for drive definitions.
 */
export interface DriveVector {
  readonly systemHealth: number;
  readonly moralValence: number;
  readonly integrity: number;
  readonly cognitiveAwareness: number;
  readonly guilt: number;
  readonly curiosity: number;
  readonly boredom: number;
  readonly anxiety: number;
  readonly satisfaction: number;
  readonly sadness: number;
  readonly informationIntegrity: number;
  readonly social: number;
}

/**
 * Drive state snapshot with metadata.
 * Includes timestamp and tick counter for correlation with events.
 */
export interface DriveSnapshot {
  readonly vector: DriveVector;
  readonly timestamp: Date;
  readonly tickNumber: number;
  readonly coldStartDampeningFactor: number;
  readonly totalPressure: number;
}

/**
 * Read-only facade for all drive state access.
 * Enforces write-protection: no methods exist to modify drives.
 * Subsystems inject IDriveStateReader, never DriveEngineService directly.
 */
export interface IDriveStateReader {
  /**
   * Current drive vector. Defensive copy -- mutating the returned object
   * does not affect internal state.
   */
  getCurrentState(): DriveVector;

  /**
   * Current snapshot including timestamp and metadata.
   */
  getCurrentSnapshot(): DriveSnapshot;

  /**
   * Observable drive state. Emits whenever drives update (~ 100Hz).
   * Consumers use this for reactive drive-modulated behavior.
   */
  readonly driveState$: Observable<DriveVector>;

  /**
   * Sum of all drive values. Utility for pressure-driven scheduling.
   */
  getTotalPressure(): number;

  /**
   * Confidence weighting for Type 1/Type 2 arbitration.
   * CANON §Type 1/Type 2 Discipline: drive state modulates threshold.
   */
  getArbitrationModulation(): number;
}
```

### 4.2 Action Outcome Reporting

```typescript
// src/drive-engine/interfaces/drive-engine.interfaces.ts

/**
 * Outcome of an action execution, sent from Decision Making to Drive Engine.
 * The Drive Engine evaluates this against behavioral contingencies.
 */
export interface ActionOutcome {
  readonly actionId: string;
  readonly actionType: string;
  readonly context: Record<string, unknown>;
  readonly predictedDriveEffects: Partial<DriveVector>;
  readonly actualDriveEffects: Partial<DriveVector>;
  readonly timestamp: Date;
  readonly executionLatencyMs: number;
  readonly success: boolean;
  readonly confidenceLevel: number;
}

/**
 * Software metrics reported by subsystems (for cold-start detection, etc).
 */
export interface SoftwareMetrics {
  readonly type1RatioLastWindow: number;
  readonly predictionMaeLastWindow: number;
  readonly sessionDurationMs: number;
  readonly totalActionsExecuted: number;
}

/**
 * Fire-and-forget outcome reporting interface.
 * Main process calls this; Drive Engine child receives outcomes asynchronously.
 */
export interface IActionOutcomeReporter {
  /**
   * Report an action outcome to the Drive Engine.
   * Does not wait for processing; returns immediately.
   * Messages are queued if the child process is temporarily unavailable.
   */
  reportOutcome(outcome: ActionOutcome): Promise<void>;

  /**
   * Report software metrics for monitoring and cold-start dampening.
   */
  reportMetrics(metrics: SoftwareMetrics): Promise<void>;

  /**
   * Signal start/end of a session (for logging and state reset).
   */
  reportSessionChange(eventType: 'START' | 'END'): Promise<void>;
}
```

### 4.3 Rule Proposing

```typescript
// src/drive-engine/interfaces/rules.interfaces.ts

/**
 * A drive rule maps event patterns to drive effects.
 * Rules live in PostgreSQL and are read-only by the main app and child process.
 * Only guardian admin can modify active rules.
 */
export interface DriveRule {
  readonly id: string;
  readonly eventType: string;
  readonly condition: unknown; // JSONB -- context matching logic
  readonly driveEffects: Record<string, number>; // { curiosity: -0.15, satisfaction: +0.10 }
  readonly status: 'ACTIVE' | 'ARCHIVED';
  readonly provenance: 'GUARDIAN' | 'SYSTEM_PROPOSED';
  readonly approvedBy: string | null;
  readonly approvedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * A proposed drive rule awaiting guardian review.
 * The system can insert into the proposal queue, not the active rules table.
 */
export interface ProposedDriveRule {
  readonly id: string;
  readonly eventType: string;
  readonly condition: unknown;
  readonly proposedEffects: Record<string, number>;
  readonly reasoning: string; // Why does the system think this rule is needed?
  readonly evidence: unknown; // Supporting event data
  readonly status: 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' | 'MODIFIED';
  readonly proposedAt: Date;
  readonly reviewedBy: string | null;
  readonly reviewedAt: Date | null;
  readonly decision: string | null;
}

/**
 * Interface for proposing new rules.
 * Inserts into proposed_drive_rules, never into drive_rules directly.
 */
export interface IRuleProposer {
  /**
   * Propose a new drive rule based on observed patterns.
   * The proposal enters a review queue and requires guardian approval
   * before becoming active. See CANON §Drive Isolation.
   */
  proposeRule(request: {
    eventType: string;
    condition: unknown;
    proposedEffects: Record<string, number>;
    reasoning: string;
    evidence: unknown;
  }): Promise<ProposedDriveRule>;

  /**
   * Query pending proposals (for guardian review interface).
   */
  getPendingProposals(): Promise<ProposedDriveRule[]>;
}
```

### 4.4 Opportunity Detection

```typescript
// src/drive-engine/interfaces/drive-engine.interfaces.ts

export type OpportunityType = 'RECURRING_FAILURE' | 'HIGH_IMPACT_FAILURE' | 'POTENTIAL';

/**
 * An Opportunity detected from prediction failures.
 * Sent to Planning subsystem for investigation and procedure creation.
 */
export interface Opportunity {
  readonly id: string;
  readonly type: OpportunityType;
  readonly priority: number; // [0.0, 1.0]
  readonly context: Record<string, unknown>;
  readonly evidence: ActionOutcome[];
  readonly detectedAt: Date;
  readonly addedToQueueAt: Date | null;
  readonly researchStartedAt: Date | null;
  readonly completedAt: Date | null;
}

/**
 * Opportunity in the priority queue with decay tracking.
 */
export interface PrioritizedOpportunity extends Opportunity {
  readonly currentPriority: number; // Priority after decay
  readonly decayRate: number;
}

/**
 * Detector interface (internal to Drive Engine; not exported).
 */
export interface IOpportunityDetector {
  evaluatePredictionAccuracy(outcomes: ActionOutcome[]): PredictionEvaluation[];
  detectOpportunities(
    evaluations: PredictionEvaluation[],
    recentHistory: PredictionEvaluation[],
    coldStartDampening: number,
  ): Opportunity[];
}

export interface PredictionEvaluation {
  readonly actionId: string;
  readonly mae: number;
  readonly isAccurate: boolean; // MAE < 0.10
  readonly isFailed: boolean;   // MAE > 0.15
  readonly context: Record<string, unknown>;
  readonly timestamp: Date;
}
```

### 4.5 IPC Message Types

```typescript
// src/drive-engine/interfaces/ipc.interfaces.ts

/**
 * Discriminated union of all IPC messages.
 * Main process sends action outcomes; child process sends drive snapshots.
 */

export type DriveIPCMessage =
  | DriveIPCActionOutcomeMessage
  | DriveIPCPredictionResultMessage
  | DriveIPCSessionChangeMessage
  | DriveIPCSoftwareMetricsMessage
  | DriveIPCDriveSnapshotMessage
  | DriveIPCOpportunityCreatedMessage
  | DriveIPCDriveEventMessage
  | DriveIPCHealthStatusMessage
  | DriveIPCReadyMessage
  | DriveIPCErrorMessage;

// ========== Main → Child ==========

export interface DriveIPCActionOutcomeMessage {
  readonly type: 'ACTION_OUTCOME';
  readonly payload: {
    readonly actionId: string;
    readonly actionType: string;
    readonly context: Record<string, unknown>;
    readonly predictedDriveEffects: Record<string, number>;
    readonly actualDriveEffects: Record<string, number>;
    readonly timestamp: string; // ISO 8601
    readonly executionLatencyMs: number;
    readonly success: boolean;
    readonly confidenceLevel: number;
  };
  readonly timestamp: string;
  readonly sequence: number; // For ordering when child catches up
}

export interface DriveIPCPredictionResultMessage {
  readonly type: 'PREDICTION_RESULT';
  readonly payload: {
    readonly actionId: string;
    readonly predictedValue: number;
    readonly actualValue: number;
    readonly mae: number;
    readonly context: Record<string, unknown>;
  };
  readonly timestamp: string;
}

export interface DriveIPCSessionChangeMessage {
  readonly type: 'SESSION_CHANGE';
  readonly payload: {
    readonly eventType: 'START' | 'END';
  };
  readonly timestamp: string;
}

export interface DriveIPCSoftwareMetricsMessage {
  readonly type: 'SOFTWARE_METRICS';
  readonly payload: {
    readonly type1RatioLastWindow: number;
    readonly predictionMaeLastWindow: number;
    readonly sessionDurationMs: number;
    readonly totalActionsExecuted: number;
  };
  readonly timestamp: string;
}

// ========== Child → Main ==========

export interface DriveIPCDriveSnapshotMessage {
  readonly type: 'DRIVE_SNAPSHOT';
  readonly payload: {
    readonly vector: Record<string, number>;
    readonly tickNumber: number;
    readonly totalPressure: number;
    readonly coldStartDampeningFactor: number;
  };
  readonly timestamp: string;
}

export interface DriveIPCOpportunityCreatedMessage {
  readonly type: 'OPPORTUNITY_CREATED';
  readonly payload: {
    readonly opportunityId: string;
    readonly type: string;
    readonly priority: number;
    readonly context: Record<string, unknown>;
    readonly evidenceCount: number;
  };
  readonly timestamp: string;
}

export interface DriveIPCDriveEventMessage {
  readonly type: 'DRIVE_EVENT';
  readonly payload: {
    readonly eventType: string;
    readonly drive: string;
    readonly delta: number;
    readonly reason: string;
  };
  readonly timestamp: string;
}

export interface DriveIPCHealthStatusMessage {
  readonly type: 'HEALTH_STATUS';
  readonly payload: {
    readonly status: 'HEALTHY' | 'DEGRADED' | 'ERROR';
    readonly message: string;
    readonly uptime: number;
    readonly lastTickMs: number;
  };
  readonly timestamp: string;
}

export interface DriveIPCReadyMessage {
  readonly type: 'READY';
  readonly payload: Record<string, never>;
  readonly timestamp: string;
}

export interface DriveIPCErrorMessage {
  readonly type: 'ERROR';
  readonly payload: {
    readonly message: string;
    readonly stack?: string;
  };
  readonly timestamp: string;
}

/**
 * Type guard for discriminated union.
 */
export function isDriveIPCMessage(value: unknown): value is DriveIPCMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    'payload' in value &&
    'timestamp' in value
  );
}
```

---

## 5. Service Implementation Details

### 5.1 DriveEngineModule Declaration

```typescript
// src/drive-engine/drive-engine.module.ts

import { Module, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DriveEngineService } from './drive-engine.service';
import { DriveReaderService } from './drive-reader/drive-reader.service';
import { ActionOutcomeReporterService } from './action-outcome-reporter/action-outcome-reporter.service';
import { RuleProposerService } from './rule-proposer/rule-proposer.service';
import { IpcChannelService } from './ipc-channel/ipc-channel.service';
import { HealthMonitorService } from './ipc-channel/health-monitor';
import { MessageHandlerService } from './ipc-channel/message-handler';
import { EventsModule } from '../events/events.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import {
  DRIVE_STATE_READER,
  ACTION_OUTCOME_REPORTER,
  RULE_PROPOSER,
  DRIVE_ENGINE_SERVICE,
} from './drive-engine.tokens';
import { DriveEngineConfig } from './config/drive-engine.config';

/**
 * Drive Engine module encapsulates the isolated process architecture.
 *
 * Exports:
 * - DRIVE_STATE_READER: IDriveStateReader (read-only facade)
 * - ACTION_OUTCOME_REPORTER: IActionOutcomeReporter (fire-and-forget)
 * - RULE_PROPOSER: IRuleProposer (insert into proposal queue)
 *
 * Write-protection is enforced:
 * - Structural: IDriveStateReader has no write methods
 * - Process-level: separate Node.js process runs computations
 * - Database-level: PostgreSQL RLS prevents unauthorized writes
 *
 * No module imports DriveEngineModule to modify drive state.
 * All other subsystems depend only on DRIVE_STATE_READER token.
 */
@Module({
  imports: [
    ConfigModule.forFeature(DriveEngineConfig),
    EventsModule,
    KnowledgeModule,
  ],
  providers: [
    // Core services
    DriveEngineService,
    IpcChannelService,
    HealthMonitorService,
    MessageHandlerService,

    // Public facades
    {
      provide: DRIVE_STATE_READER,
      useClass: DriveReaderService,
    },
    {
      provide: ACTION_OUTCOME_REPORTER,
      useClass: ActionOutcomeReporterService,
    },
    {
      provide: RULE_PROPOSER,
      useClass: RuleProposerService,
    },

    // Re-export main service for module init
    {
      provide: DRIVE_ENGINE_SERVICE,
      useClass: DriveEngineService,
    },
  ],
  exports: [
    DRIVE_STATE_READER,
    ACTION_OUTCOME_REPORTER,
    RULE_PROPOSER,
  ],
})
export class DriveEngineModule implements OnModuleInit {
  private readonly logger = new Logger(DriveEngineModule.name);

  constructor(
    @Inject(DRIVE_ENGINE_SERVICE)
    private readonly driveEngine: DriveEngineService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.logger.log('Initializing Drive Engine module...');
    await this.driveEngine.initialize();
    this.logger.log('Drive Engine ready');
  }
}
```

### 5.2 DriveReaderService

```typescript
// src/drive-engine/drive-reader/drive-reader.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { Subject, Observable } from 'rxjs';
import { IDriveStateReader, DriveVector, DriveSnapshot } from '../interfaces/drive-engine.interfaces';
import { IpcChannelService } from '../ipc-channel/ipc-channel.service';

/**
 * Read-only facade for drive state access.
 *
 * Enforces write-protection through interface design:
 * - No methods to modify drives
 * - Defensive copies of snapshots
 * - One-way subscription to drive updates
 *
 * Receives drive snapshots from the isolated child process via IPC.
 * Caches the latest snapshot and serves it to all consumers.
 */
@Injectable()
export class DriveReaderService implements IDriveStateReader {
  private readonly logger = new Logger(DriveReaderService.name);

  /**
   * RxJS Subject for drive state updates.
   * Child process sends DRIVE_SNAPSHOT messages on each tick (~100Hz).
   */
  private readonly _driveState$ = new Subject<DriveVector>();

  /**
   * Latest snapshot cached in memory.
   * Initialized with defaults; updated on each DRIVE_SNAPSHOT message.
   */
  private latestSnapshot: DriveSnapshot = this.getDefaultSnapshot();

  constructor(private readonly ipcChannel: IpcChannelService) {
    // Subscribe to incoming drive snapshots from child process
    this.ipcChannel.onDriveSnapshot((snapshot: DriveSnapshot) => {
      this.latestSnapshot = snapshot;
      // Emit vector only (not full snapshot) to RxJS subscribers
      this._driveState$.next(this.defensiveCopy(snapshot.vector));
    });
  }

  /**
   * Current drive vector.
   * Returns a defensive copy to prevent accidental mutations.
   */
  getCurrentState(): DriveVector {
    return this.defensiveCopy(this.latestSnapshot.vector);
  }

  /**
   * Current snapshot including timestamp and metadata.
   * Defensive copy to preserve immutability guarantee.
   */
  getCurrentSnapshot(): DriveSnapshot {
    return {
      ...this.latestSnapshot,
      vector: this.defensiveCopy(this.latestSnapshot.vector),
    };
  }

  /**
   * Observable drive state stream.
   * Emits whenever drives update (sourced from child process ticks).
   * Use this for drive-modulated behavior, drive cost reporting, etc.
   */
  get driveState$(): Observable<DriveVector> {
    return this._driveState$.asObservable();
  }

  /**
   * Sum of all drive values. Utility for pressure-driven scheduling.
   * Per CANON §Drive Accumulation.
   */
  getTotalPressure(): number {
    const vector = this.latestSnapshot.vector;
    return (
      vector.systemHealth +
      vector.moralValence +
      vector.integrity +
      vector.cognitiveAwareness +
      vector.guilt +
      vector.curiosity +
      vector.boredom +
      vector.anxiety +
      vector.satisfaction +
      vector.sadness +
      vector.informationIntegrity +
      vector.social
    );
  }

  /**
   * Drive-modulated arbitration threshold.
   * Per CANON §Type 1/Type 2 Discipline: drives affect confidence ceiling.
   * High anxiety/low integrity -> lower threshold (Type 2 more likely).
   * High satisfaction -> higher threshold (Type 1 more likely).
   */
  getArbitrationModulation(): number {
    const vector = this.latestSnapshot.vector;

    // Anxiety increases threshold (makes Type 2 harder to beat)
    const anxietyEffect = vector.anxiety * 0.15;

    // Low integrity increases threshold
    const integrityEffect = (1 - vector.integrity) * 0.10;

    // High satisfaction increases threshold (Type 1 more likely)
    const satisfactionEffect = vector.satisfaction * 0.05;

    return 1.0 + anxietyEffect + integrityEffect - satisfactionEffect;
  }

  /**
   * Create a defensive copy of a drive vector.
   * Prevents consumers from mutating the internal state.
   */
  private defensiveCopy(vector: DriveVector): DriveVector {
    return { ...vector };
  }

  /**
   * Default snapshot (idle state).
   * Used until first DRIVE_SNAPSHOT message arrives from child.
   */
  private getDefaultSnapshot(): DriveSnapshot {
    return {
      vector: {
        systemHealth: 0.5,
        moralValence: 0.5,
        integrity: 0.5,
        cognitiveAwareness: 0.5,
        guilt: 0.0,
        curiosity: 0.3,
        boredom: 0.2,
        anxiety: 0.2,
        satisfaction: 0.4,
        sadness: 0.1,
        informationIntegrity: 0.5,
        social: 0.3,
      },
      timestamp: new Date(),
      tickNumber: 0,
      coldStartDampeningFactor: 1.0,
      totalPressure: 4.5,
    };
  }
}
```

### 5.3 ActionOutcomeReporterService

```typescript
// src/drive-engine/action-outcome-reporter/action-outcome-reporter.service.ts

import { Injectable, Logger } from '@nestjs/common';
import {
  IActionOutcomeReporter,
  ActionOutcome,
  SoftwareMetrics,
} from '../interfaces/drive-engine.interfaces';
import { IpcChannelService } from '../ipc-channel/ipc-channel.service';
import { OutcomeQueue } from './outcome-queue';

/**
 * Fire-and-forget action outcome reporting.
 *
 * When an action is executed by Decision Making, the outcome is reported here.
 * The service queues it for the child process and returns immediately.
 * The child process processes outcomes on its own tick cycle.
 *
 * If the child process is temporarily unavailable, the queue buffers messages
 * and flushes them when connectivity is restored.
 */
@Injectable()
export class ActionOutcomeReporterService implements IActionOutcomeReporter {
  private readonly logger = new Logger(ActionOutcomeReporterService.name);
  private readonly queue = new OutcomeQueue();

  constructor(private readonly ipcChannel: IpcChannelService) {
    // When IPC channel becomes healthy again, flush queued messages
    this.ipcChannel.onHealthy(() => {
      this.logger.log('IPC channel healthy; flushing outcome queue');
      this.queue.flush((message) => {
        this.ipcChannel.send(message);
      });
    });

    // When IPC channel becomes unhealthy, pause flush
    this.ipcChannel.onUnhealthy(() => {
      this.logger.warn('IPC channel unhealthy; queuing outcomes');
      this.queue.pause();
    });
  }

  /**
   * Report an action outcome to the Drive Engine.
   * Returns immediately; processing happens asynchronously in the child.
   *
   * The Drive Engine uses outcomes to:
   * 1. Update drive state via behavioral contingencies
   * 2. Evaluate prediction accuracy
   * 3. Detect opportunities for the Planning subsystem
   *
   * Per CANON §Contingency Requirement: every outcome trace to a specific behavior.
   */
  async reportOutcome(outcome: ActionOutcome): Promise<void> {
    const message = {
      type: 'ACTION_OUTCOME',
      payload: {
        actionId: outcome.actionId,
        actionType: outcome.actionType,
        context: outcome.context,
        predictedDriveEffects: outcome.predictedDriveEffects,
        actualDriveEffects: outcome.actualDriveEffects,
        timestamp: outcome.timestamp.toISOString(),
        executionLatencyMs: outcome.executionLatencyMs,
        success: outcome.success,
        confidenceLevel: outcome.confidenceLevel,
      },
      timestamp: new Date().toISOString(),
      sequence: this.queue.getNextSequence(),
    };

    this.queue.enqueue(message);
    this.tryFlush();

    this.logger.debug(`Queued outcome: ${outcome.actionId}`, {
      actionType: outcome.actionType,
      success: outcome.success,
    });
  }

  /**
   * Report software metrics (Type 1/Type 2 ratio, prediction MAE, etc.).
   * Used by the Drive Engine to compute cold-start dampening and monitor
   * system health.
   */
  async reportMetrics(metrics: SoftwareMetrics): Promise<void> {
    const message = {
      type: 'SOFTWARE_METRICS',
      payload: {
        type1RatioLastWindow: metrics.type1RatioLastWindow,
        predictionMaeLastWindow: metrics.predictionMaeLastWindow,
        sessionDurationMs: metrics.sessionDurationMs,
        totalActionsExecuted: metrics.totalActionsExecuted,
      },
      timestamp: new Date().toISOString(),
    };

    this.queue.enqueue(message);
    this.tryFlush();
  }

  /**
   * Signal start/end of a session.
   * Used for logging and to reset drive state at session boundaries.
   */
  async reportSessionChange(eventType: 'START' | 'END'): Promise<void> {
    const message = {
      type: 'SESSION_CHANGE',
      payload: { eventType },
      timestamp: new Date().toISOString(),
    };

    this.queue.enqueue(message);
    this.tryFlush();

    this.logger.log(`Session ${eventType}`);
  }

  /**
   * Attempt to flush queued messages if IPC is healthy.
   */
  private tryFlush(): void {
    if (this.ipcChannel.isHealthy()) {
      this.queue.flush((message) => {
        this.ipcChannel.send(message);
      });
    }
  }
}
```

### 5.4 RuleProposerService

```typescript
// src/drive-engine/rule-proposer/rule-proposer.service.ts

import { Injectable, Inject, Logger } from '@nestjs/common';
import { IRuleProposer, ProposedDriveRule } from '../interfaces/rules.interfaces';
import { EVENTS_SERVICE } from '../../events/events.tokens';
import { IEventsService } from '../../events/interfaces/events.interfaces';
import { PostgresRulesClient } from './postgres-rules-client';

/**
 * Propose new drive rules.
 *
 * The Drive Engine can detect patterns (e.g., "every time action X happens,
 * drive Y increases by Z") and propose new rules to encode those patterns
 * as hard rules. This avoids recomputing the same pattern repeatedly.
 *
 * However, proposed rules do NOT become active until a guardian reviews
 * and approves them. This enforces Immutable Standard 6 (No Self-Modification
 * of Evaluation): the system cannot change the rules unilaterally.
 *
 * Per CANON §Drive Isolation: "The system can PROPOSE new rules, but they
 * enter a review queue -- they do not self-activate."
 */
@Injectable()
export class RuleProposerService implements IRuleProposer {
  private readonly logger = new Logger(RuleProposerService.name);

  constructor(
    @Inject(EVENTS_SERVICE)
    private readonly events: IEventsService,
    private readonly postgres: PostgresRulesClient,
  ) {}

  /**
   * Propose a new drive rule based on observed patterns.
   *
   * Inserts into proposed_drive_rules table (PostgreSQL role: sylphie_app can INSERT).
   * Does NOT insert into drive_rules (PostgreSQL role: sylphie_app cannot INSERT/UPDATE).
   *
   * The proposal includes:
   * - Event type pattern (e.g., "action_success_under_high_curiosity")
   * - Condition JSONB (context matching logic)
   * - Proposed drive effects (e.g., { curiosity: -0.15 })
   * - Reasoning: why does the system think this rule is beneficial?
   * - Evidence: supporting event data from TimescaleDB
   */
  async proposeRule(request: {
    eventType: string;
    condition: unknown;
    proposedEffects: Record<string, number>;
    reasoning: string;
    evidence: unknown;
  }): Promise<ProposedDriveRule> {
    this.logger.log(`Proposing rule for event type: ${request.eventType}`, {
      reasoning: request.reasoning,
    });

    // Insert into proposed_drive_rules
    const proposal = await this.postgres.insertProposal({
      eventType: request.eventType,
      condition: request.condition,
      proposedEffects: request.proposedEffects,
      reasoning: request.reasoning,
      evidence: request.evidence,
    });

    // Emit event for telemetry/monitoring
    await this.events.record({
      type: 'RULE_PROPOSED',
      subsystem: 'DRIVE_ENGINE',
      payload: {
        proposalId: proposal.id,
        eventType: proposal.eventType,
        reasoning: proposal.reasoning,
      },
    });

    return proposal;
  }

  /**
   * Query pending proposals (for guardian review interface).
   * Read-only access to proposed_drive_rules.
   */
  async getPendingProposals(): Promise<ProposedDriveRule[]> {
    return this.postgres.getPendingProposals();
  }
}
```

### 5.5 IpcChannelService

```typescript
// src/drive-engine/ipc-channel/ipc-channel.service.ts

import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { spawn, ChildProcess } from 'child_process';
import { Subject, Observable } from 'rxjs';
import { DriveIPCMessage, DriveSnapshot } from '../interfaces/ipc.interfaces';
import { HealthMonitorService } from './health-monitor';
import { MessageHandlerService } from './message-handler';
import { isDriveIPCMessage } from '../interfaces/ipc.interfaces';

/**
 * IPC channel management for the Drive Engine child process.
 *
 * Responsibilities:
 * - Fork the child process on module init
 * - Route incoming messages to handlers
 * - Send messages to child (fire-and-forget)
 * - Monitor child process health
 * - Recover from crashes (respawn)
 * - Enforce one-way communication (main cannot write drive state)
 */
@Injectable()
export class IpcChannelService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IpcChannelService.name);

  private child: ChildProcess | null = null;
  private isReady = false;

  /** Subject for incoming drive snapshots from child */
  private readonly driveSnapshot$ = new Subject<DriveSnapshot>();

  constructor(
    private readonly healthMonitor: HealthMonitorService,
    private readonly messageHandler: MessageHandlerService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.logger.log('Initializing IPC channel...');
    await this.forkChild();
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log('Shutting down IPC channel...');
    if (this.child) {
      this.child.kill('SIGTERM');
      this.child = null;
    }
  }

  /**
   * Fork the child process.
   * Waits for READY message before considering initialization complete.
   */
  private async forkChild(): Promise<void> {
    this.child = spawn('node', [
      // Path to the child process entry point
      require.resolve('../drive-process/main.ts'),
    ]);

    this.child.on('message', (message: unknown) => {
      if (!isDriveIPCMessage(message)) {
        this.logger.warn('Received malformed IPC message', { message });
        return;
      }

      this.handleMessage(message);
    });

    this.child.on('error', (error: Error) => {
      this.logger.error('Child process error', error);
      this.healthMonitor.markUnhealthy('Child process error');
      this.attemptRecovery();
    });

    this.child.on('exit', (code: number | null, signal: string | null) => {
      this.logger.warn('Child process exited', { code, signal });
      this.healthMonitor.markUnhealthy('Child process exited');
      this.attemptRecovery();
    });

    // Wait for READY message with timeout
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Drive Engine child process did not become ready within 5s'));
      }, 5000);

      const listener = (message: unknown) => {
        if (isDriveIPCMessage(message) && message.type === 'READY') {
          clearTimeout(timeout);
          this.child?.removeListener('message', listener);
          this.isReady = true;
          this.healthMonitor.markHealthy();
          this.logger.log('Drive Engine child process ready');
          resolve();
        }
      };

      this.child?.on('message', listener);
    });
  }

  /**
   * Send a message to the child process.
   * Fire-and-forget; does not wait for a response.
   * If child is unavailable, caller is responsible for queueing.
   */
  send(message: DriveIPCMessage): void {
    if (!this.child || !this.isReady) {
      this.logger.warn('Cannot send message: child process not ready');
      return;
    }

    try {
      this.child.send(message);
    } catch (error) {
      this.logger.error('Failed to send message to child', error);
      this.healthMonitor.markUnhealthy('Failed to send message');
    }
  }

  /**
   * Is the child process healthy and responsive?
   */
  isHealthy(): boolean {
    return this.isReady && this.healthMonitor.isHealthy();
  }

  /**
   * Subscribe to drive snapshot updates from child.
   */
  onDriveSnapshot(callback: (snapshot: DriveSnapshot) => void): void {
    this.driveSnapshot$.subscribe(callback);
  }

  /**
   * Event emitters for health state changes.
   */
  onHealthy(callback: () => void): void {
    this.healthMonitor.onHealthy(callback);
  }

  onUnhealthy(callback: () => void): void {
    this.healthMonitor.onUnhealthy(callback);
  }

  /**
   * Route incoming messages from child to handlers.
   */
  private handleMessage(message: DriveIPCMessage): void {
    switch (message.type) {
      case 'DRIVE_SNAPSHOT':
        this.handleDriveSnapshot(message);
        break;
      case 'OPPORTUNITY_CREATED':
        this.messageHandler.handleOpportunityCreated(message);
        break;
      case 'DRIVE_EVENT':
        this.messageHandler.handleDriveEvent(message);
        break;
      case 'HEALTH_STATUS':
        this.messageHandler.handleHealthStatus(message);
        break;
      case 'ERROR':
        this.messageHandler.handleError(message);
        break;
      default:
        this.logger.warn('Unknown message type', { type: message.type });
    }
  }

  /**
   * Handle DRIVE_SNAPSHOT message from child.
   * Extract snapshot and emit to driveState$ observable.
   */
  private handleDriveSnapshot(message: {
    type: 'DRIVE_SNAPSHOT';
    payload: {
      vector: Record<string, number>;
      tickNumber: number;
      totalPressure: number;
      coldStartDampeningFactor: number;
    };
    timestamp: string;
  }): void {
    const snapshot: DriveSnapshot = {
      vector: message.payload.vector as any, // TODO: validate shape
      timestamp: new Date(message.timestamp),
      tickNumber: message.payload.tickNumber,
      coldStartDampeningFactor: message.payload.coldStartDampeningFactor,
      totalPressure: message.payload.totalPressure,
    };

    this.driveSnapshot$.next(snapshot);
    this.healthMonitor.recordTick();
  }

  /**
   * Attempt to recover from child process failure.
   * Waits a short delay, then respawns.
   */
  private async attemptRecovery(): Promise<void> {
    this.logger.warn('Attempting recovery...');
    this.isReady = false;

    // Wait before respawning to avoid tight loop
    await new Promise((resolve) => setTimeout(resolve, 1000));

    try {
      await this.forkChild();
    } catch (error) {
      this.logger.error('Recovery failed', error);
      this.healthMonitor.markUnhealthy('Recovery failed');
    }
  }
}
```

---

## 6. Child Process Architecture

### 6.1 Entry Point (main.ts)

```typescript
// src/drive-engine/drive-process/main.ts

/**
 * Drive Engine child process entry point.
 *
 * This runs in a separate Node.js process, completely isolated from the main
 * NestJS application. It has its own event loop, its own connections to
 * PostgreSQL and Grafeo, and its own event emission to TimescaleDB.
 *
 * The main process communicates via process.send() and process.on('message').
 * This is the only communication channel: one-way for drive state (child → main)
 * and fire-and-forget for outcomes (main → child).
 */

import { DriveEngineProcess } from './drive-engine';
import { getChildProcessConfig } from './config';
import { Logger } from '@nestjs/common';

const logger = new Logger('DriveEngineProcess');

async function main(): Promise<void> {
  try {
    const config = getChildProcessConfig();
    const engine = new DriveEngineProcess(config);

    await engine.initialize();

    // Signal ready to parent
    process.send({
      type: 'READY',
      payload: {},
      timestamp: new Date().toISOString(),
    });

    // Start the tick loop
    engine.start();

    logger.log('Drive Engine process started');
  } catch (error) {
    logger.error('Failed to start Drive Engine process', error);
    process.exit(1);
  }
}

// Handle messages from parent
process.on('message', (message: unknown) => {
  // Delegate to engine (not shown for brevity)
});

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  logger.log('Received SIGTERM, shutting down...');
  process.exit(0);
});

main().catch((error) => {
  logger.error('Unhandled error in main', error);
  process.exit(1);
});
```

### 6.2 DriveEngineProcess (Core Computation)

```typescript
// src/drive-engine/drive-process/drive-engine.ts

/**
 * Core Drive Engine computation.
 *
 * Runs on a 100Hz tick loop (or configurable rate).
 * Each tick:
 * 1. Process queued action outcomes
 * 2. Apply drive rules from PostgreSQL
 * 3. Accumulate drive pressure over time
 * 4. Run self-evaluation (slower timescale)
 * 5. Evaluate prediction accuracy
 * 6. Detect opportunities
 * 7. Emit events to TimescaleDB
 * 8. Publish drive snapshot back to main process
 *
 * No imports from NestJS or main process code.
 * Pure computation + isolated database clients.
 */

export class DriveEngineProcess {
  private driveState: DriveVector;
  private tickNumber = 0;
  private selfEvalCounter = 0;
  private readonly outcomeQueue: ActionOutcome[] = [];
  private readonly opportunityQueue: PrioritizedOpportunity[] = [];
  private tickIntervalHandle: NodeJS.Timer | null = null;

  constructor(private readonly config: DriveEngineProcessConfig) {}

  async initialize(): Promise<void> {
    // Connect to PostgreSQL (read-only role)
    await this.postgres.connect();

    // Connect to Grafeo (Self KG, read-only)
    await this.grafeo.connect();

    // Connect to TimescaleDB (write events)
    await this.timescale.connect();

    // Load initial drive rules
    await this.ruleEngine.loadRules();

    // Initialize drive state
    this.driveState = this.getDefaultDriveState();
  }

  start(): void {
    const tickIntervalMs = 1000 / this.config.tickRateHz;

    this.tickIntervalHandle = setInterval(() => {
      try {
        this.tick();
      } catch (error) {
        this.handleTickError(error);
      }
    }, tickIntervalMs);
  }

  stop(): void {
    if (this.tickIntervalHandle) {
      clearInterval(this.tickIntervalHandle);
      this.tickIntervalHandle = null;
    }
  }

  /**
   * Main tick loop.
   */
  private tick(): void {
    this.tickNumber++;

    // 1. Process queued outcomes from main process
    const newOutcomes = this.drainOutcomeQueue();

    // 2. Apply rules to recent events
    await this.ruleEngine.applyRules(newOutcomes);

    // 3. Accumulate drive pressure
    this.accumulateDrives();

    // 4. Self-evaluation on slower timescale
    if (this.shouldRunSelfEval()) {
      await this.runSelfEvaluation();
    }

    // 5. Evaluate prediction accuracy
    const evaluations = this.evaluatePredictions(newOutcomes);

    // 6. Detect opportunities
    const newOpportunities = this.detectOpportunities(evaluations);
    for (const opp of newOpportunities) {
      this.opportunityQueue.push(opp);
      this.publishOpportunity(opp);
    }

    // 7. Decay opportunity priorities
    this.decayOpportunities();

    // 8. Emit tick event to TimescaleDB
    await this.emitTickEvent();

    // 9. Publish drive snapshot back to main
    this.publishDriveSnapshot();

    // 10. Emit opportunity queue status
    this.emitOpportunityQueueStatus();
  }

  /**
   * Accumulate drive pressure over time.
   * Different drives accumulate at different rates.
   * Cross-modulation applies (one drive affects another's rate).
   */
  private accumulateDrives(): void {
    // Per CANON §Drive Accumulation
    // Implement accumulation rates, cross-modulation, clamping
  }

  /**
   * Should self-evaluation run this tick?
   * Slower timescale prevents identity lock-in.
   */
  private shouldRunSelfEval(): boolean {
    this.selfEvalCounter++;
    if (this.selfEvalCounter >= this.config.selfEvalIntervalTicks) {
      this.selfEvalCounter = 0;
      return true;
    }
    return false;
  }

  /**
   * Run self-evaluation from KG(Self).
   * Updates drive baselines based on self-concept.
   */
  private async runSelfEvaluation(): Promise<void> {
    // Read self-model from Grafeo
    const selfModel = await this.grafeo.getCurrentModel();

    // Aggregate recent performance
    const performance = this.aggregatePerformance();

    // Update drives based on consistency
    if (performance.consistency > 0.7) {
      this.updateSelfDrives(performance);
    }

    // Emit self-eval event
    await this.timescale.emitEvent({
      type: 'SELF_EVALUATION',
      timestamp: new Date(),
      payload: { consistency: performance.consistency },
    });
  }

  /**
   * Evaluate prediction accuracy from outcomes.
   * Compare predicted drive effects to actual.
   */
  private evaluatePredictions(outcomes: ActionOutcome[]): PredictionEvaluation[] {
    return outcomes.map(outcome => ({
      actionId: outcome.actionId,
      mae: this.computeMAE(
        outcome.predictedDriveEffects,
        outcome.actualDriveEffects,
      ),
      isAccurate: true, // computed below
      isFailed: true,   // computed below
      context: outcome.context,
      timestamp: outcome.timestamp,
    }));
  }

  /**
   * Detect opportunities from prediction failures.
   * Recurring patterns → Opportunity
   * High-impact failures → Opportunity
   * Otherwise → Potential Opportunity
   */
  private detectOpportunities(
    evaluations: PredictionEvaluation[],
  ): PrioritizedOpportunity[] {
    // Per drive.md §Opportunity Detection
    // Implement recurring pattern detection, impact thresholds, cold-start dampening
    return [];
  }

  /**
   * Decay opportunity priorities over time.
   * Unaddressed opportunities lose priority.
   */
  private decayOpportunities(): void {
    this.opportunityQueue.forEach(opp => {
      opp.currentPriority *= 1 - this.config.opportunityDecayRate;
    });

    // Remove negligible opportunities
    const filtered = this.opportunityQueue.filter(opp => opp.currentPriority > 0.01);
    this.opportunityQueue.length = 0;
    this.opportunityQueue.push(...filtered);
  }

  /**
   * Emit a DRIVE_SNAPSHOT message back to parent.
   */
  private publishDriveSnapshot(): void {
    const totalPressure = this.computeTotalPressure();
    const coldStartDampening = this.computeColdStartDampening();

    process.send({
      type: 'DRIVE_SNAPSHOT',
      payload: {
        vector: this.driveState,
        tickNumber: this.tickNumber,
        totalPressure,
        coldStartDampeningFactor: coldStartDampening,
      },
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Handle errors in tick loop.
   * Emit error event but continue ticking.
   */
  private handleTickError(error: unknown): void {
    process.send({
      type: 'ERROR',
      payload: {
        message: String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      timestamp: new Date().toISOString(),
    });
  }

  // ... other private methods
}
```

---

## 7. Configuration Management

### 7.1 DriveEngineConfig (Main Process)

```typescript
// src/drive-engine/config/drive-engine.config.ts

import { registerAs } from '@nestjs/config';
import { IsNumber, IsString, Min, Max, IsOptional } from 'class-validator';

export class DriveEngineConfig {
  @IsNumber()
  @Min(10)
  @Max(1000)
  tickRateHz: number = 100;

  @IsNumber()
  @Min(1)
  @Max(100)
  selfEvalIntervalTicks: number = 10;

  @IsNumber()
  @Min(0)
  @Max(1)
  opportunityDecayRate: number = 0.05;

  @IsNumber()
  @Min(0)
  @Max(1)
  coldStartDampeningInitial: number = 0.8;

  @IsNumber()
  @Min(0)
  @Max(1)
  coldStartDampeningDecayPerSession: number = 0.1;

  @IsString()
  @IsOptional()
  childProcessPath: string = require.resolve('./drive-process/main.ts');

  @IsString()
  postgresUrl: string;

  @IsString()
  grafeoUrl: string;

  @IsString()
  timescaleUrl: string;
}

export default registerAs('driveEngine', () => new DriveEngineConfig());
```

### 7.2 Child Process Config

```typescript
// src/drive-engine/drive-process/config.ts

export interface DriveEngineProcessConfig {
  tickRateHz: number;
  selfEvalIntervalTicks: number;
  opportunityDecayRate: number;
  coldStartDampeningInitial: number;
  coldStartDampeningDecayPerSession: number;

  // Database URLs for isolated connections
  postgresUrl: string;
  grafeoUrl: string;
  timescaleUrl: string;

  // Drive computation constants
  drives: {
    [key: string]: {
      baseRate: number;
      maxRate: number;
    };
  };

  // Behavioral contingencies
  contingencies: {
    satisfactionHabituation: number[];
    anxietyAmplification: number;
    guiltRepair: {
      acknowledgmentOnly: number;
      behaviorChangeOnly: number;
      both: number;
    };
    socialCommentQuality: {
      responseTimeMs: number;
      reliefSocial: number;
      reliefSatisfaction: number;
    };
  };
}

export function getChildProcessConfig(): DriveEngineProcessConfig {
  return {
    tickRateHz: parseInt(process.env.DRIVE_TICK_RATE_HZ || '100'),
    selfEvalIntervalTicks: parseInt(process.env.DRIVE_SELF_EVAL_INTERVAL_TICKS || '10'),
    opportunityDecayRate: parseFloat(process.env.DRIVE_OPPORTUNITY_DECAY_RATE || '0.05'),
    coldStartDampeningInitial: parseFloat(
      process.env.DRIVE_COLD_START_DAMPENING_INITIAL || '0.8',
    ),
    coldStartDampeningDecayPerSession: parseFloat(
      process.env.DRIVE_COLD_START_DAMPENING_DECAY || '0.1',
    ),

    postgresUrl: process.env.DATABASE_URL || 'postgres://localhost/sylphie',
    grafeoUrl: process.env.GRAFEO_URL || 'http://localhost:9000',
    timescaleUrl: process.env.TIMESCALE_URL || 'postgres://localhost/sylphie_events',

    // ... drive rates and contingencies
  };
}
```

---

## 8. Injection Tokens

```typescript
// src/drive-engine/drive-engine.tokens.ts

/**
 * NestJS DI tokens for Drive Engine services.
 * Other modules inject these tokens to access drive functionality.
 *
 * Key principle: Only DRIVE_STATE_READER is exported for general consumption.
 * ACTION_OUTCOME_REPORTER and RULE_PROPOSER are used internally or by
 * their respective subsystems.
 */

export const DRIVE_ENGINE_SERVICE = Symbol('DRIVE_ENGINE_SERVICE');

/**
 * Read-only facade for drive state.
 * All subsystems depend on this. No write methods exposed.
 */
export const DRIVE_STATE_READER = Symbol('DRIVE_STATE_READER');

/**
 * Fire-and-forget outcome reporting.
 * Decision Making uses this to report action outcomes.
 */
export const ACTION_OUTCOME_REPORTER = Symbol('ACTION_OUTCOME_REPORTER');

/**
 * Rule proposal interface.
 * Drive Engine uses this internally; exposed for testing/monitoring.
 */
export const RULE_PROPOSER = Symbol('RULE_PROPOSER');

/**
 * IPC channel (internal only, not exported).
 */
export const IPC_CHANNEL = Symbol('IPC_CHANNEL');
```

---

## 9. Error Handling

### 9.1 Exception Hierarchy

```typescript
// src/drive-engine/exceptions/drive-engine.exception.ts

import { SylphieException } from '../../shared/exceptions/sylphie.exception';

/**
 * Base exception for Drive Engine errors.
 */
export class DriveEngineException extends SylphieException {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, context);
  }
}

/**
 * Attempted to write to drive state (isolation violation).
 * Should never happen if interfaces are designed correctly.
 * If this is thrown, an architectural boundary has been violated.
 */
export class DriveIsolationViolationError extends DriveEngineException {
  constructor(attemptedOperation: string) {
    super(
      `Drive isolation violation: attempted to ${attemptedOperation}`,
      { attemptedOperation },
    );
  }
}

/**
 * Child process is unavailable or crashed.
 */
export class DriveProcessUnavailableError extends DriveEngineException {
  constructor(reason: string) {
    super(`Drive Engine process unavailable: ${reason}`, { reason });
  }
}

/**
 * Message sent to child process is malformed.
 */
export class InvalidDriveIPCMessageError extends DriveEngineException {
  constructor(message: unknown) {
    super('Invalid Drive IPC message format', { received: typeof message });
  }
}

/**
 * Rule loading or validation failed.
 */
export class DriveRuleError extends DriveEngineException {
  constructor(message: string, context?: Record<string, unknown>) {
    super(`Drive rule error: ${message}`, context);
  }
}
```

---

## 10. Health Monitoring and Recovery

### 10.1 HealthMonitorService

```typescript
// src/drive-engine/ipc-channel/health-monitor.ts

import { Subject } from 'rxjs';
import { Logger } from '@nestjs/common';

/**
 * Monitor health of the Drive Engine child process.
 *
 * Tracks:
 * - Is the child responsive (receiving drive snapshots)?
 * - How long since last tick?
 * - Has the child crashed?
 *
 * If health degrades, signal to DriveReaderService to use cached state
 * and to ActionOutcomeReporterService to queue messages.
 */
export class HealthMonitorService {
  private readonly logger = new Logger(HealthMonitorService.name);

  private isHealthy_ = false;
  private lastTickMs = 0;
  private lastHealthyAt = Date.now();

  private readonly healthy$ = new Subject<void>();
  private readonly unhealthy$ = new Subject<void>();

  constructor(
    private readonly healthTimeoutMs: number = 5000,
    private readonly tickIntervalMs: number = 10,
  ) {
    // Periodically check if child is responsive
    setInterval(() => {
      const now = Date.now();
      const timeSinceLastTick = now - this.lastTickMs;

      if (timeSinceLastTick > this.healthTimeoutMs && this.isHealthy_) {
        this.markUnhealthy('No tick received within timeout');
      }
    }, 1000);
  }

  /**
   * Record a successful tick from the child process.
   */
  recordTick(): void {
    this.lastTickMs = Date.now();
  }

  /**
   * Mark child as healthy.
   */
  markHealthy(): void {
    if (!this.isHealthy_) {
      this.isHealthy_ = true;
      this.lastHealthyAt = Date.now();
      this.logger.log('Drive Engine healthy');
      this.healthy$.next();
    }
  }

  /**
   * Mark child as unhealthy.
   */
  markUnhealthy(reason: string): void {
    if (this.isHealthy_) {
      this.isHealthy_ = false;
      this.logger.warn(`Drive Engine unhealthy: ${reason}`);
      this.unhealthy$.next();
    }
  }

  /**
   * Is the child process healthy?
   */
  isHealthy(): boolean {
    return this.isHealthy_;
  }

  /**
   * Time since child was last healthy (ms).
   */
  timeSinceHealthy(): number {
    return Date.now() - this.lastHealthyAt;
  }

  /**
   * Subscribe to health state transitions.
   */
  onHealthy(callback: () => void): void {
    this.healthy$.subscribe(callback);
  }

  onUnhealthy(callback: () => void): void {
    this.unhealthy$.subscribe(callback);
  }
}
```

---

## 11. Testing Strategy

### 11.1 Unit Testing (Child Process in Isolation)

```typescript
/**
 * Test the Drive Engine computation without IPC.
 *
 * Instantiate DriveEngineProcess directly with mock database clients.
 * Inject outcomes, verify drive state changes, verify opportunity detection.
 */

describe('DriveEngineProcess', () => {
  describe('tick loop', () => {
    it('should accumulate drive pressure over time', () => {
      // Verify drives accumulate at configured rates
    });

    it('should apply drive rules from PostgreSQL', () => {
      // Inject outcomes, verify rule lookup and drive effects
    });

    it('should detect opportunities from recurring prediction failures', () => {
      // Inject multiple similar failures, verify Opportunity created
    });

    it('should decay opportunity priorities', () => {
      // Verify unaddressed opportunities lose priority
    });

    it('should enforce cold-start dampening', () => {
      // Verify early prediction failures generate fewer opportunities
    });

    it('should prevent depressive attractor state', () => {
      // Verify self-evaluation consistency requirement
      // Verify floor on Satisfaction
    });
  });

  describe('behavioral contingencies', () => {
    it('should apply satisfaction habituation curve', () => {
      // Verify diminishing returns: +0.20, +0.15, +0.10, +0.05, +0.02
    });

    it('should amplify anxiety consequences', () => {
      // High anxiety (>0.7) + failure = 1.5x confidence reduction
    });

    it('should require both acknowledgment AND behavior change for guilt relief', () => {
      // Verify guilt repair contingency: -0.10 (ack only), -0.15 (change only), -0.30 (both)
    });

    it('should reinforce social comment quality', () => {
      // Guardian response within 30s = +0.10 Satisfaction
    });

    it('should compute curiosity relief proportional to information gain', () => {
      // New nodes, confidence increases, resolved errors = relief
      // Revisiting known territory = minimal relief
    });
  });
});
```

### 11.2 Integration Testing (IPC Channel)

```typescript
/**
 * Test IPC communication and recovery.
 */

describe('IpcChannelService', () => {
  describe('communication', () => {
    it('should send outcomes to child process', async () => {
      // Create channel, send outcome, verify child received
    });

    it('should queue outcomes if child is unavailable', async () => {
      // Simulate child crash, send outcome, verify queued
      // Verify flushed on recovery
    });

    it('should receive drive snapshots from child', async () => {
      // Subscribe to driveState$ observable
      // Verify snapshots received on each tick
    });
  });

  describe('health monitoring', () => {
    it('should detect child crash and trigger recovery', async () => {
      // Simulate child exit, verify recovery attempted
    });

    it('should mark as unhealthy if no tick for timeout period', async () => {
      // Simulate slow child, verify health degradation
    });

    it('should respawn child and re-establish IPC', async () => {
      // Verify new child process spawned
      // Verify READY message received
    });
  });

  describe('write-protection', () => {
    it('should never expose write methods to main process', () => {
      // IDriveStateReader should have zero write methods
      // Verify interface shape
    });

    it('should queue outcomes for asynchronous processing', async () => {
      // Verify fire-and-forget pattern
    });
  });
});
```

### 11.3 End-to-End Verification (CANON Compliance)

```typescript
/**
 * Verify Epic 4 deliverables against CANON.
 */

describe('Epic 4 Deliverables', () => {
  it('should enforce drive isolation at process boundary', () => {
    // Verify separate process exists and communicates via IPC only
  });

  it('should prevent self-modification of evaluation function', () => {
    // Verify no write path to drive_rules from main application
    // Verify PostgreSQL RLS prevents autonomous modification
    // Verify child process uses read-only role
  });

  it('should apply all behavioral contingencies', () => {
    // Test suite coverage of satisfaction, anxiety, guilt, social, curiosity
  });

  it('should detect opportunities from prediction failures', () => {
    // Verify recurring pattern detection
    // Verify high-impact single failures
    // Verify potential opportunities
  });

  it('should implement self-evaluation on slower timescale', () => {
    // Verify self-evaluation doesn't run every tick
    // Verify prevents identity lock-in
    // Verify prevents depressive attractor
  });

  it('should compute cold-start dampening correctly', () => {
    // Verify dampening factor decreases over time
    // Verify early prediction failures generate fewer opportunities
  });
});
```

---

## 12. Deployment and Operations

### 12.1 Environment Variables

```bash
# src/.env.example

# Drive Engine Configuration
DRIVE_TICK_RATE_HZ=100
DRIVE_SELF_EVAL_INTERVAL_TICKS=10
DRIVE_OPPORTUNITY_DECAY_RATE=0.05
DRIVE_COLD_START_DAMPENING_INITIAL=0.8
DRIVE_COLD_START_DAMPENING_DECAY_PER_SESSION=0.1

# Database connections (used by child process)
DATABASE_URL=postgres://sylphie_app:password@localhost:5432/sylphie
GRAFEO_URL=http://localhost:9000
TIMESCALE_URL=postgres://timescale_user:password@localhost:5432/sylphie_events
```

### 12.2 PostgreSQL Role Setup

```sql
-- Create read-only role for main application
CREATE ROLE sylphie_app LOGIN PASSWORD 'password';
GRANT SELECT ON drive_rules TO sylphie_app;
GRANT SELECT, INSERT ON proposed_drive_rules TO sylphie_app;

-- Create read-only role for child process
CREATE ROLE drive_engine LOGIN PASSWORD 'password';
GRANT SELECT ON drive_rules TO drive_engine;

-- Guardian admin role for rule approvals
CREATE ROLE guardian_admin LOGIN PASSWORD 'password';
GRANT ALL ON drive_rules TO guardian_admin;
```

---

## 13. Key Decisions and Rationale

| Decision | Rationale |
|----------|-----------|
| Separate Node.js process (not thread) | Process isolation provides true architectural boundary; impossible to accidentally call write methods; enables independent crash recovery. |
| child_process.fork() for IPC | Built-in, no external dependencies, typed message passing via JSON, handles stdio separation automatically. |
| Fire-and-forget outcomes | Decouples main process from Drive Engine tick rate; allows async processing; enables queueing during recovery. |
| RxJS Observables for drive state | Idiomatic NestJS, reactive subscribers don't poll, efficient for high-frequency updates (100Hz). |
| 100Hz tick rate | Fast enough for real-time behavioral response; slow enough to avoid resource exhaustion on modest hardware. |
| Self-evaluation on slower timescale | Prevents identity lock-in from short-term fluctuations; requires consistent evidence before updating self-concept. |
| Opportunity priority queue with decay | Prevents backlog accumulation; forces Planning to address high-impact issues first; old opportunities eventually drop below threshold. |
| Cold-start dampening | Early prediction failures don't flood system with low-quality procedures; dampening factor decreases as system matures. |
| PostgreSQL RLS for rule write-protection | Database layer enforces constraint that main app and child cannot modify active rules; only guardian can. |
| Proposed rule queue | Allows system to suggest optimizations; requires explicit guardian review before activation; transparent audit trail. |

---

## 14. Known Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Child process crashes silently | High | Health monitor detects no-tick timeout; automatic respawn with buffered message flush. |
| IPC messages lost during recovery | Medium | OutcomeQueue buffers messages; only flushes when child is healthy. |
| Drive state stale during child recovery | Medium | DriveReaderService caches latest snapshot; defaults to idle state if child never initialized. |
| Child process deadlock | Low | Tight single-threaded loop; no locks; inputs are fire-and-forget queues. |
| PostgreSQL connection leaks | Medium | Each connection wrapped in try/finally; OnModuleDestroy closes all handles. |
| High-frequency IPC message overhead | Low | 100 snapshots/sec × few KB/message = manageable; monitor for degradation. |

---

## 15. Success Criteria (Epic 4 Completion)

- [ ] **Structural write-protection:** IDriveStateReader interface has zero write methods; TypeScript compiler enforces read-only access.
- [ ] **Process isolation:** Separate Node.js process spawned on startup; IPC-only communication; can crash and respawn independently.
- [ ] **One-way communication:** Main → Child is fire-and-forget (no response expected); Child → Main is snapshots (Main cannot write back).
- [ ] **12-drive computation:** All drives accumulate, cross-modulate, apply rules, get clamped to [0.0, 1.0].
- [ ] **Behavioral contingencies:** Satisfaction habituation, anxiety amplification, guilt repair, social comment quality, curiosity information gain all implemented.
- [ ] **Opportunity detection:** Recurring failures, high-impact failures, potential opportunities detected with correct priority.
- [ ] **Opportunity decay:** Unaddressed opportunities lose priority; no infinite queue buildup.
- [ ] **Self-evaluation:** Runs on slower timescale; prevents identity lock-in; requires consistency before updating.
- [ ] **Cold-start dampening:** Early prediction failures generate fewer opportunities; factor decreases over sessions.
- [ ] **PostgreSQL RLS:** sylphie_app role cannot write to drive_rules; can insert to proposed_drive_rules only.
- [ ] **Health monitoring:** Child process crashes detected within 5s; automatic respawn with message buffering.
- [ ] **IPC message types:** All 10+ message types defined and handled; type guards validate shape.
- [ ] **Logging and telemetry:** All drive events emitted to TimescaleDB; no blind spots.
- [ ] **Tests pass:** Unit tests (child in isolation), integration tests (IPC), end-to-end (CANON compliance).
- [ ] **Type checking:** `npx tsc --noEmit` passes with strict mode enabled.

---

## References

- **CANON:** `/wiki/CANON.md` — Immutable architectural principles
- **Drive Agent Profile:** `/.claude/agents/drive.md` — Drive Engine domain expertise
- **Forge Agent Profile:** `/.claude/agents/forge.md` — NestJS architectural patterns
- **Phase 1 Roadmap:** `/wiki/phase-1/roadmap.md` — Epic 4 dependencies and deliverables
- **Confidence Dynamics:** CANON §Confidence Dynamics (ACT-R)
- **Behavioral Contingencies:** CANON §Behavioral Contingency Structure
- **Known Attractor States:** CANON §Known Attractor States
