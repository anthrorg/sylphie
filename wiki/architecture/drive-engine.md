# drive-engine — Architecture Reference

> Living document. Last updated: 2026-06-13. Auto-generated from full-file reads (one agent per file); verify before trusting any single line.

**69 files** mapped.

## File-by-file

### `packages/drive-engine/src/`

#### action-outcome-reporter.service.spec.ts
*test* — Unit tests for ActionOutcomeReporterService covering anxiety injection and dead ternary fix.

Spec file testing ActionOutcomeReporterService with three test suites: (1) anxiety injection verifies reportOutcome() sends live anxiety from DriveReaderService and handles cold-start (anxiety=0); (2) dead ternary cleanup confirms driveValue is used directly regardless of expressionType and defaults to 0 when null; (3) feedbackSource mapping tests GUARDIAN→guardian_confirmation and LLM_GENERATED→algorithmic mappings. Uses helper functions createMockWsChannel(), createMockDriveReader(anxietyValue), and createOutcome(overrides) to construct test fixtures. Payload structure validated includes actionId, actionType, success, driveEffects, feedbackSource, and theaterCheck object with expressionType, correspondingDrive, driveValue, isTheatrical. No actual assertions on sent payloads captured—tests verify driveReader.getCurrentState() calls only.

- **Deps:** `./action-outcome-reporter.service`, `@sylphie/shared (DriveName, INITIAL_DRIVE_STATE)`
- **Gotchas:** Tests call driveReader.getCurrentState() but do NOT inspect sent payloads via wsChannel.sent array (created but never asserted). Dead ternary suite verifies calls happen (line 123: toHaveBeenCalledTimes(2)) but doesn't validate actual payload contents or anxiety values injected. Test coverage is behavioral/integration-level, not deep structural validation. Spec assumes ActionOutcomeReporterService constructor signature is (wsChannel, driveReader).

#### action-outcome-reporter.service.ts
*service* — Fire-and-forget IPC bridge: converts action outcomes and software metrics to payload format and enqueues them for async delivery to Drive Engine child process.

ActionOutcomeReporterService implements IActionOutcomeReporter and is a NestJS Injectable singleton. It wraps an OutcomeQueue that batches and retries IPC messages via WebSocket. reportOutcome() accepts outcome + theater-check data, maps ProvenanceSource to guardian/algorithmic feedback types, captures current anxiety pressure, and queues via enqueueOutcome(). reportMetrics() wraps SoftwareMetrics (LLM call count, latency, cognitive effort pressure, token count) into SoftwareMetricsPayload and queues via enqueueMetrics(). resetDriveState() sends a SESSION_START message with INITIAL_DRIVE_STATE to cold-start the Drive Engine. Theater Prohibition check is enforced: if isTheatrical=true, Drive Engine applies zero-reinforcement. Guardian Asymmetry (CANON Standard 5) is mapped in mapProvenanceToFeedbackSource(): GUARDIAN, TAUGHT_PROCEDURE, GUARDIAN_APPROVED_INFERENCE→guardian_confirmation; SENSOR, LLM_GENERATED, INFERENCE, BEHAVIORAL_INFERENCE, SYSTEM_BOOTSTRAP→algorithmic. OutcomeQueue configured with maxQueueSize=1000, maxRetries=3, baseRetryDelayMs=10. No drive state mutation occurs here — only observational data is sent.

- **Exports:** `ActionOutcomeReporterService`
- **Key constants:** `maxQueueSize=1000`, `maxRetries=3`, `baseRetryDelayMs=10`
- **Deps:** `@nestjs/common`, `./interfaces/drive-engine.interfaces`, `@sylphie/shared`, `./ipc-channel/ws-channel.service`, `./action-outcome-reporter/outcome-queue`, `./drive-reader.service`
- **Gotchas:** Two TODOs in reportMetrics(): estimatedCostUsd hardcoded to 0 (no token-to-cost mapping), windowStartAt/windowEndAt both set to now (not tracking actual caller window boundaries). Theater check driveValue defaults to 0 if null; correspondingDrive defaults to SystemHealth if null. No validation that actionId is actually provided despite CANON Standard 2 requirement.

#### drive-engine.module.ts
*module* — NestJS client module for Sylphie's drive (motivation) subsystem, connecting via WebSocket to standalone drive-server

Exports three public DI tokens: DRIVE_STATE_READER (read-only drive state facade), ACTION_OUTCOME_REPORTER (fire-and-forget outcome writes), and RULE_PROPOSER (guardian-gated rule proposals). Establishes PostgreSQL runtime pool with RLS enforcement (host=localhost:5434, db=sylphie_system, user=sylphie_app, max=5 connections, 30s idle timeout). Wires DriveReaderService, ActionOutcomeReporterService, RuleProposerService, and DriveProcessManagerService. OnModuleInit calls processManager.start() to connect to drive-server; OnModuleDestroy calls stop(). No direct access to drive rules or internal state allowed — only wire-protocol snapshots, enforcing CANON §Drive Isolation.

- **Exports:** `DriveEngineModule`, `DRIVE_STATE_READER`, `ACTION_OUTCOME_REPORTER`, `RULE_PROPOSER`
- **Key constants:** `postgres.host=localhost`, `postgres.port=5434`, `postgres.database=sylphie_system`, `postgres.runtimeUser=sylphie_app`, `postgres.max=5`, `postgres.idleTimeoutMillis=30000`, `postgres.connectionTimeoutMillis=5000`
- **Deps:** `@nestjs/common`, `@nestjs/config`, `pg`, `@sylphie/shared`, `./drive-engine.tokens`, `./drive-reader.service`, `./action-outcome-reporter.service`, `./rule-proposer.service`, `./drive-process/drive-process-manager.service`, `./rule-proposer/postgres-rules-client`, `./ipc-channel/ws-channel.service`

#### drive-engine.tokens.ts
*config* — NestJS dependency injection tokens for DriveEngineModule

Defines four Symbol-based injection tokens for NestJS DI container binding. DRIVE_STATE_READER provides read-only drive state facade; ACTION_OUTCOME_REPORTER provides fire-and-forget IPC write channel for outcomes/metrics; RULE_PROPOSER provides guardian-gated rule proposals (all three exported publicly via index.ts). DRIVE_PROCESS_MANAGER manages child process lifecycle but is deliberately kept internal to DriveEngineModule to prevent coupling of other modules to process infrastructure. Uses Symbols instead of concrete classes to enable interface-based injection and decouple consumers from implementation details.

- **Exports:** `DRIVE_STATE_READER`, `ACTION_OUTCOME_REPORTER`, `RULE_PROPOSER`, `DRIVE_PROCESS_MANAGER`
- **Gotchas:** DRIVE_PROCESS_MANAGER is exported from this file but NOT re-exported from index.ts barrel to enforce module boundary; consumers must not import it directly.

#### drive-reader.service.ts
*service* — Read-only facade for drive state; enforces CANON isolation and immutability.

DriveReaderService implements IDriveStateReader and provides read-only access to drive snapshots. It maintains a BehaviorSubject-backed driveState$ Observable that emits the current DriveSnapshot (starts with COLD_START_SNAPSHOT, updated by DriveProcessManagerService on child process IPC). Key methods: getCurrentState() returns a defensive copy of the snapshot; getTotalPressure() delegates to snapshot.totalPressure; isDriveHealthy() checks tick > 0 and staleness < 2000ms; updateSnapshot() coerces timestamp to Date, validates coherence via validateDriveSnapshotCoherence(), and emits to subscribers. All drive values enforced in range [-10.0, 1.0]; totalPressure computed by child process on every tick (target 100Hz). One-way data flow: snapshots flow out from Drive Engine process, never inward (CANON Standard 6).

- **Exports:** `DriveReaderService`
- **Key constants:** `ZERO_DELTA={SystemHealth:0, MoralValence:0, Integrity:0, CognitiveAwareness:0, Guilt:0, Curiosity:0, Boredom:0, Anxiety:0, Satisfaction:0, Sadness:0, Focus:0, Social:0}`, `INITIAL_TOTAL_PRESSURE=computeTotalPressure(INITIAL_DRIVE_STATE)`, `COLD_START_SNAPSHOT={pressureVector:INITIAL_DRIVE_STATE, timestamp:epoch, tickNumber:0, driveDeltas:ZERO_DELTA, ruleMatchResult:{ruleId:null, eventType:'COLD_START', matched:false}, totalPressure:INITIAL_TOTAL_PRESSURE, sessionId:'cold-start'}`, `Staleness threshold=2000ms`, `Health threshold=tick > 0 and staleness < 2000ms`
- **Deps:** `@nestjs/common (Injectable, Logger)`, `rxjs (Observable, BehaviorSubject)`, `@sylphie/shared (DriveSnapshot, INITIAL_DRIVE_STATE, DriveName, computeTotalPressure, verboseFor, DriveCoherenceError)`, `./interfaces/drive-engine.interfaces (IDriveStateReader)`, `./drive-reader/drive-state-snapshot (validateDriveSnapshotCoherence, defensiveCopySnapshot)`
- **Gotchas:** Timestamp coercion in updateSnapshot() handles JSON deserialization (ISO string → Date); snapshot is never null but tick=0 means unhealthy (cold-start); no mutation permitted on returned defensive copies; validation error throws DriveCoherenceError with logged error context

#### index.ts
*barrel* — Public API contract for DriveEngineModule — exports DI tokens, interfaces, and data shapes while hiding internal services and process management.

This is a strict barrel export enforcing module boundaries. It exports DriveEngineModule (the NestJS module), three public DI tokens (DRIVE_STATE_READER, ACTION_OUTCOME_REPORTER, RULE_PROPOSER), and six public interface/type exports (IDriveStateReader, IActionOutcomeReporter, IRuleProposer, Opportunity, OpportunityClassification, ProposedDriveRule, SoftwareMetrics). Deliberately excludes DRIVE_PROCESS_MANAGER and IDriveProcessManager (internal process lifecycle). IDriveStateReader is a read-only facade with zero write methods (CANON Standard 6 — No Self-Modification of Evaluation). IActionOutcomeReporter is a fire-and-forget IPC channel for outcomes and metrics, enforcing CANON Standard 1 (Theater Prohibition) and Standard 2 (Contingency Requirement via actionId). IRuleProposer inserts to proposed_drive_rules only; active rules are write-protected. SoftwareMetrics carries cognitiveEffortPressure [0.0, 1.0] to create evolutionary drive pressure toward Type 1 graduation.

- **Exports:** `DriveEngineModule`, `DRIVE_STATE_READER`, `ACTION_OUTCOME_REPORTER`, `RULE_PROPOSER`, `IDriveStateReader`, `IActionOutcomeReporter`, `IRuleProposer`, `Opportunity`, `OpportunityClassification`, `ProposedDriveRule`, `SoftwareMetrics`
- **Deps:** `./drive-engine.module`, `./drive-engine.tokens`, `./interfaces/drive-engine.interfaces`
- **Gotchas:** DRIVE_PROCESS_MANAGER and IDriveProcessManager intentionally omitted from public API to prevent coupling to infrastructure. Module boundary is enforced via explicit re-export contract.

#### rule-proposer.service.ts
*service* — Submit proposed drive rules to PostgreSQL review queue, gated by guardian approval per CANON §6 (no self-modification).

RuleProposerService (@Injectable) implements IRuleProposer interface. Single public method proposeRule(rule: ProposedDriveRule) accepts rule with eventType, driveEffects (partial drive deltas), rationale, proposedBy, and condition. Maps proposal to database format: serializes driveEffects as JSON string for effect column, hard-codes confidence=0.5 for all new proposals, injects proposedBy and reasoning. Delegates INSERT to PostgresRulesClient.insertProposedRule(). All proposals inserted with status='pending' into proposed_drive_rules table. Logging on success and error; no external event emission (deferred to Drive Engine or Planning subsystem). Read-only service: cannot modify active drive_rules (RLS-protected, guardian-only via dashboard).

- **Exports:** `RuleProposerService`
- **Key constants:** `confidence=0.5 (base confidence for all new proposals)`, `status='pending' (implicit in insertProposedRule)`
- **Deps:** `@nestjs/common (Injectable, Logger)`, `./interfaces/drive-engine.interfaces (IRuleProposer, ProposedDriveRule)`, `./rule-proposer/postgres-rules-client (PostgresRulesClient)`
- **Gotchas:** Hard-coded confidence 0.5 for all proposals regardless of quality; effect serialization as JSON string may limit querying; no external event emission here (caller responsibility); error logging but no retry logic; rationale field labeled 'reasoning' in DB call

### `packages/drive-engine/src/action-outcome-reporter/`

#### outcome-queue.ts
*service* — FIFO queue for asynchronous delivery of action outcomes and software metrics to the Drive Engine process.

OutcomeQueue buffers ACTION_OUTCOME and SOFTWARE_METRICS messages with fire-and-forget async delivery via setImmediate(). Implements exponential backoff retry logic (up to maxRetries per message) when child process is temporarily unavailable. Enforces maxQueueSize (default 1000) by dropping oldest messages on overflow. All operations are synchronous for minimal latency. Key methods: enqueueOutcome(payload), enqueueMetrics(payload), size(), drainSync() for graceful shutdown. Private flush() operates FIFO, peeking before removal, re-queuing failed messages with exponential backoff (baseRetryDelayMs * 2^(retries-1)). QueuedMessage tracks retries and enqueuedAt timestamp. Honors CANON §Drive Isolation (one-way IPC from main process).

- **Exports:** `OutcomeQueue`, `OutcomeQueueConfig`
- **Key constants:** `maxQueueSize=1000`, `maxRetries=3`, `baseRetryDelayMs=10`
- **Deps:** `@nestjs/common`, `@sylphie/shared`

### `packages/drive-engine/src/constants/`

#### action-emotions.ts
*config* — Action-to-emotion mappings for theater-prohibition canon checks

Maps action types (speak_happily, express_concern, apologize, etc.) to emotional expressions and the drives they claim to activate. Enforces CANON §Theater Prohibition: output must correlate with actual drive state. For each action, specifies emotion (satisfaction, anxiety, curiosity, guilt, boredom, social), expressionType (pressure|relief), and thresholds (pressureThreshold > 0.2, reliefThreshold < 0.3). Exports ACTION_EMOTION_MAPPINGS as a read-only Map with 10 action-emotion pairs. Provides getActionEmotionMapping() for lookup and registerActionEmotionMapping() for runtime learning of new patterns.

- **Exports:** `ActionEmotionMapping`, `ACTION_EMOTION_MAPPINGS`, `getActionEmotionMapping`, `registerActionEmotionMapping`
- **Key constants:** `pressureThreshold=0.2`, `reliefThreshold=0.3`, `expressionType values: pressure, relief`
- **Deps:** `@sylphie/shared (DriveName type)`
- **Gotchas:** All 10 mappings use identical thresholds (0.2/0.3); registerActionEmotionMapping mutates the frozen Map at runtime via type-cast, which is a code-smell for testing/learning paths.

#### drives.ts
*config* — CANON-mandated immutable configuration for the 12-drive motivational system

Exports two main drive configuration Maps: DRIVE_ACCUMULATION_RATES (per-tick pressure buildup; core drives at 0.0, complement drives 0.0003-0.0015) and DRIVE_DECAY_RATES (per-tick relief; Satisfaction -0.0009, Sadness/Focus -0.0006, rest 0.0). Seven cross-modulation thresholds (anxiety-curiosity 0.7, satisfaction-boredom 0.6, boredom-curiosity 0.6, guilt-satisfaction 0.4, anxiety-integrity 0.7, system-health-anxiety 0.7). Seven coefficients for cross-modulation dynamics (0.003-0.03 multipliers/additive effects). Process health guardrails: DRIVE_PROCESS_MAX_MEMORY_MB=10, MAX_OUTCOME_QUEUE_LENGTH=1000. All values are immutable and CANON-aligned for 1Hz tick interval (1000ms).

- **Exports:** `DRIVE_ENGINE_TICK_INTERVAL_MS`, `MAX_TICK_DRIFT_MS`, `DRIVE_ACCUMULATION_RATES`, `DRIVE_DECAY_RATES`, `ANXIETY_CURIOSITY_SUPPRESSION_THRESHOLD`, `ANXIETY_CURIOSITY_SUPPRESSION_COEFFICIENT`, `SATISFACTION_BOREDOM_SUPPRESSION_THRESHOLD`, `SATISFACTION_BOREDOM_SUPPRESSION_COEFFICIENT`, `ANXIETY_INTEGRITY_AMPLIFICATION_THRESHOLD`, `ANXIETY_INTEGRITY_AMPLIFICATION_COEFFICIENT`, `SYSTEM_HEALTH_ANXIETY_AMPLIFICATION_THRESHOLD`, `SYSTEM_HEALTH_ANXIETY_AMPLIFICATION_COEFFICIENT`, `BOREDOM_CURIOSITY_AMPLIFICATION_THRESHOLD`, `BOREDOM_CURIOSITY_AMPLIFICATION_COEFFICIENT`, `GUILT_SATISFACTION_SUPPRESSION_THRESHOLD`, `GUILT_SATISFACTION_SUPPRESSION_COEFFICIENT`, `DRIVE_PROCESS_MAX_MEMORY_MB`, `MAX_OUTCOME_QUEUE_LENGTH`
- **Key constants:** `DRIVE_ENGINE_TICK_INTERVAL_MS=1000`, `MAX_TICK_DRIFT_MS=100`, `DRIVE_ACCUMULATION_RATES={Curiosity:0.0012, Boredom:0.0015, Anxiety:0.0003, Social:0.0009, others:0.0}`, `DRIVE_DECAY_RATES={Satisfaction:-0.0009, Sadness:-0.0006, Focus:-0.0006, others:0.0}`, `ANXIETY_CURIOSITY_SUPPRESSION_THRESHOLD=0.7`, `ANXIETY_CURIOSITY_SUPPRESSION_COEFFICIENT=0.03`, `SATISFACTION_BOREDOM_SUPPRESSION_THRESHOLD=0.6`, `SATISFACTION_BOREDOM_SUPPRESSION_COEFFICIENT=0.03`, `ANXIETY_INTEGRITY_AMPLIFICATION_THRESHOLD=0.7`, `ANXIETY_INTEGRITY_AMPLIFICATION_COEFFICIENT=0.0012`, `SYSTEM_HEALTH_ANXIETY_AMPLIFICATION_THRESHOLD=0.7`, `SYSTEM_HEALTH_ANXIETY_AMPLIFICATION_COEFFICIENT=0.003`, `BOREDOM_CURIOSITY_AMPLIFICATION_THRESHOLD=0.6`, `BOREDOM_CURIOSITY_AMPLIFICATION_COEFFICIENT=0.003`, `GUILT_SATISFACTION_SUPPRESSION_THRESHOLD=0.4`, `GUILT_SATISFACTION_SUPPRESSION_COEFFICIENT=0.03`, `DRIVE_PROCESS_MAX_MEMORY_MB=10`, `MAX_OUTCOME_QUEUE_LENGTH=1000`
- **Deps:** `@sylphie/shared (DriveName)`
- **Gotchas:** SystemHealth is composite (derived in cross-modulation, not accumulated). Core drives (MoralValence, Integrity, CognitiveAwareness) are action-driven only. Accumulation/decay comments include calculated fill times (e.g., Curiosity ~10min from 0.3, Satisfaction relief ~18min decay). Cross-modulation uses multiplicative (suppression) and additive (amplification) effects with distinct coefficients.

#### events.ts
*config* — Drive Engine event and batching configuration constants

Exports DriveEngineEventType enum with 6 event types (DRIVE_TICK, OUTCOME_PROCESSED, OPPORTUNITY_CREATED, CONTINGENCY_APPLIED, SELF_EVALUATION_RUN, RULE_APPLIED, HEALTH_STATUS). Defines batching thresholds: BATCH_SIZE=50 events triggers immediate flush, BATCH_TIMEOUT_MS=100 for time-based flush. Queue management: MAX_QUEUE_SIZE=10000 drops oldest events on overflow. Retry logic: RETRY_COUNT=3 with RETRY_BASE_DELAY_MS=50 for exponential backoff (50ms, 100ms, 200ms). Sampling config: DRIVE_TICK_SAMPLE_INTERVAL=1 samples every tick, HEALTH_STATUS_INTERVAL_TICKS=60 for 60-second heartbeat. Implements CANON §Drive Isolation: dedicated batching pipeline from Drive Engine child process to TimescaleDB with queue, batch, timeout, and failure handling.

- **Exports:** `DriveEngineEventType`, `BATCH_SIZE`, `BATCH_TIMEOUT_MS`, `MAX_QUEUE_SIZE`, `RETRY_COUNT`, `RETRY_BASE_DELAY_MS`, `DRIVE_TICK_SAMPLE_INTERVAL`, `HEALTH_STATUS_INTERVAL_TICKS`
- **Key constants:** `BATCH_SIZE=50`, `BATCH_TIMEOUT_MS=100`, `MAX_QUEUE_SIZE=10000`, `RETRY_COUNT=3`, `RETRY_BASE_DELAY_MS=50`, `DRIVE_TICK_SAMPLE_INTERVAL=1`, `HEALTH_STATUS_INTERVAL_TICKS=60`
- **Gotchas:** None noted; well-documented with clear intent and no visible stubs or TODOs

#### opportunity-detection.ts
*config* — Constants and thresholds for Drive Engine opportunity detection and classification

Defines classification thresholds (RECURRING_FAILURE_THRESHOLD=3, HIGH_IMPACT_MAE_THRESHOLD=0.40, HIGH_IMPACT_PRESSURE_THRESHOLD=0.8, LOW_PRIORITY_THRESHOLD=0.20), cold-start dampening (COLD_START_SESSION_COUNT=10 with formula priority *= min(1.0, sessionNumber / 10)), opportunity decay mechanics (DECAY_MAE_THRESHOLD=0.10, DECAY_PRIORITY_REDUCTION=0.5, DECAY_REMOVAL_CONSECUTIVE_THRESHOLD=100 for removal after 100 consecutive good predictions), queue management (MAX_QUEUE_SIZE=50 active opportunities), and emission rate limiting (EMISSION_INTERVAL_TICKS=1, EMISSION_MAX_PER_CYCLE=5). Decay circuit runs every DECAY_CHECK_INTERVAL_TICKS=1. De-duplication enabled (DEDUPLICATION_ENABLED=true) to prevent queue spam for same predictionType. Registry safety cap (MAX_REGISTRY_SIZE=200) with LRU eviction by insertion order.

- **Exports:** `RECURRING_FAILURE_THRESHOLD`, `HIGH_IMPACT_MAE_THRESHOLD`, `HIGH_IMPACT_PRESSURE_THRESHOLD`, `LOW_PRIORITY_THRESHOLD`, `COLD_START_SESSION_COUNT`, `DECAY_MAE_THRESHOLD`, `DECAY_PRIORITY_REDUCTION`, `DECAY_REMOVAL_CONSECUTIVE_THRESHOLD`, `MAX_QUEUE_SIZE`, `EMISSION_INTERVAL_TICKS`, `EMISSION_MAX_PER_CYCLE`, `DECAY_CHECK_INTERVAL_TICKS`, `DEDUPLICATION_ENABLED`, `MAX_REGISTRY_SIZE`
- **Key constants:** `RECURRING_FAILURE_THRESHOLD=3`, `HIGH_IMPACT_MAE_THRESHOLD=0.40`, `HIGH_IMPACT_PRESSURE_THRESHOLD=0.8`, `LOW_PRIORITY_THRESHOLD=0.20`, `COLD_START_SESSION_COUNT=10`, `DECAY_MAE_THRESHOLD=0.10`, `DECAY_PRIORITY_REDUCTION=0.5`, `DECAY_REMOVAL_CONSECUTIVE_THRESHOLD=100`, `MAX_QUEUE_SIZE=50`, `EMISSION_INTERVAL_TICKS=1`, `EMISSION_MAX_PER_CYCLE=5`, `DECAY_CHECK_INTERVAL_TICKS=1`, `DEDUPLICATION_ENABLED=true`, `MAX_REGISTRY_SIZE=200`
- **Gotchas:** None identified - straightforward constant definitions aligned with CANON §E4-T010 opportunity detection specification

#### prediction-evaluation.ts
*config* — Prediction evaluation constants for MAE-based behavior graduation and demotion logic.

Exports 9 constants governing Mean Absolute Error (MAE) thresholds for Type 1/Type 2 behavior transition decisions in the drive engine. MAE_WINDOW_SIZE (10) defines rolling prediction window; MAE classification thresholds (ACCURATE=0.10, MODERATE=0.20) categorize model reliability. Type 1 graduation requires confidence>0.80 and MAE<0.10; demotion triggers at MAE>=0.15. Cache TTL set to 60s. Opportunity severity classification: LOW (MAE 0.20-0.30), MEDIUM (0.30-0.40), HIGH (>=0.40); only MEDIUM/HIGH trigger IPC OPPORTUNITY_CREATED signals. MIN_SAMPLE_COUNT=1 permits graduated decisions with partial data. Implements CANON §E4-T009 and CANON §Type 1/Type 2 Discipline for prediction-driven autonomy.

- **Exports:** `MAE_WINDOW_SIZE`, `MAE_ACCURATE_THRESHOLD`, `MAE_MODERATE_THRESHOLD`, `GRADUATION_CONFIDENCE_THRESHOLD`, `GRADUATION_MAE_THRESHOLD`, `DEMOTION_MAE_THRESHOLD`, `CACHE_TTL_MS`, `OPPORTUNITY_SEVERITY_LOW_THRESHOLD`, `OPPORTUNITY_SEVERITY_MEDIUM_THRESHOLD`, `MIN_SAMPLE_COUNT`
- **Key constants:** `MAE_WINDOW_SIZE=10`, `MAE_ACCURATE_THRESHOLD=0.10`, `MAE_MODERATE_THRESHOLD=0.20`, `GRADUATION_CONFIDENCE_THRESHOLD=0.80`, `GRADUATION_MAE_THRESHOLD=0.10`, `DEMOTION_MAE_THRESHOLD=0.15`, `CACHE_TTL_MS=60000`, `OPPORTUNITY_SEVERITY_LOW_THRESHOLD=0.30`, `OPPORTUNITY_SEVERITY_MEDIUM_THRESHOLD=0.40`, `MIN_SAMPLE_COUNT=1`
- **Gotchas:** No dead code or stubs. MIN_SAMPLE_COUNT=1 is permissive (allows graduation with minimal data); comment flags this as deliberate.

#### rules.ts
*config* — Default affects and rule-engine configuration for drive pressure responses

Defines rule-engine operational thresholds (RULE_RELOAD_INTERVAL_MS=60000ms, RULE_CONFIDENCE_THRESHOLD=0.3, RULE_CACHE_MAX_SIZE=500) and baseline drive-affect mappings when no custom PostgreSQL rules match. Primary conversation relief is -0.367 per response (targets ~30 responses to move drives from 1.0 to -10.0). ACTION_TYPE_DEFAULTS map action categories (ConversationalResponse, GuardianEngagement, KnowledgeQuery, etc.) to drive-delta maps; sensory actions (UndiscoveredObjectPressure, UnknownPersonPressure, SensoryPrediction, ScenePrediction) are metadata-scaled by counts/magnitudes. OUTCOME_DEFAULTS add bonuses for guardian confirmation (+0.15 Satisfaction, -0.10 MoralValence) and correction (+0.15 Guilt, -0.10 Satisfaction). computeDefaultAffect() function combines action-type base effects, outcome bonuses, and metadata scaling to emit final drive-effects map.

- **Exports:** `RULE_RELOAD_INTERVAL_MS`, `RULE_CONFIDENCE_THRESHOLD`, `RULE_CACHE_MAX_SIZE`, `PRIMARY_RELIEF`, `SECONDARY_RELIEF`, `ACTION_TYPE_DEFAULTS`, `OUTCOME_DEFAULTS`, `METADATA_SCALED_ACTION_TYPES`, `computeDefaultAffect`
- **Key constants:** `RULE_RELOAD_INTERVAL_MS=60000`, `RULE_CONFIDENCE_THRESHOLD=0.3`, `RULE_CACHE_MAX_SIZE=500`, `PRIMARY_RELIEF=-0.367`, `SECONDARY_RELIEF=-0.183`
- **Deps:** `@sylphie/shared`
- **Gotchas:** PRIMARY_RELIEF and SECONDARY_RELIEF are unexported private constants; RULE_CONFIDENCE_THRESHOLD at 0.3 is permissive (allows experimental rules); sensory action types require matching metadata fields (undiscoveredObjectCount, unknownPersonCount, sensoryPredictionError, sceneSurprise) or scaling fails silently

#### self-evaluation.ts
*config* — Drive Engine self-evaluation cadence and baseline adjustment thresholds

Defines timing and control parameters for the Drive Engine's slower-timescale self-assessment loop. Controls how often (every N ticks) the engine reads KG(Self) to adjust drive baselines and prevent rumination. Implements circuit-breaker protection (trip after 5 consecutive negative assessments, pause 5s) and baseline recovery mechanics (reduce 5% on low capability, recover 1% per cycle). Maps four KG(Self) capabilities (social_interaction, knowledge_retrieval, prediction_accuracy, error_correction) to specific drives (Social, CognitiveAwareness, Integrity, MoralValence). Query timeout set to 500ms to prevent tick-loop blocking per CANON §E4-T008.

- **Exports:** `SELF_EVALUATION_INTERVAL_TICKS`, `CIRCUIT_BREAKER_NEGATIVE_THRESHOLD`, `CIRCUIT_BREAKER_PAUSE_DURATION_MS`, `BASELINE_REDUCTION_RATE`, `BASELINE_RECOVERY_RATE`, `LOW_CAPABILITY_THRESHOLD`, `HIGH_CAPABILITY_THRESHOLD`, `CAPABILITY_TO_DRIVE_MAP`, `SELF_KG_QUERY_TIMEOUT_MS`
- **Key constants:** `SELF_EVALUATION_INTERVAL_TICKS=10`, `CIRCUIT_BREAKER_NEGATIVE_THRESHOLD=5`, `CIRCUIT_BREAKER_PAUSE_DURATION_MS=5000`, `BASELINE_REDUCTION_RATE=0.05`, `BASELINE_RECOVERY_RATE=0.01`, `LOW_CAPABILITY_THRESHOLD=0.3`, `HIGH_CAPABILITY_THRESHOLD=0.7`, `SELF_KG_QUERY_TIMEOUT_MS=500`
- **Deps:** `@sylphie/shared (DriveName)`

### `packages/drive-engine/src/drive-process/`

#### accumulation.ts
*util* — Compute drive pressure accumulation and decay rates per tick, validate rate consistency at startup.

Exports two functions: getDriveUpdateRates() computes combined accumulation+decay per-drive rates (applied each tick as additive deltas, bounded to [-10.0, 1.0]); validateRates() checks that accumulation rates are non-negative, decay rates are non-positive, and no drive mixes both (catches tuning errors at startup). Implements CANON §A.14 per-drive pressure buildup/relief semantics. Imports DRIVE_ACCUMULATION_RATES and DRIVE_DECAY_RATES constants from ../constants/drives and DriveName enum from @sylphie/shared.

- **Exports:** `getDriveUpdateRates`, `validateRates`
- **Deps:** `@sylphie/shared`, `../constants/drives`
- **Gotchas:** Bounds clamped to [-10.0, 1.0] post-update; no clamping visible in this file but documented. Design assumes either accumulation OR decay per drive, not both.

#### clamping.ts
*util* — Drive value boundary enforcement and validation per CANON §A.1

Implements clamping and validation for drive state values within the [-10.0, 1.0] bounds mandated by the Six Immutable Standards. Provides isWithinBounds() for boolean validation, clampDrive() for individual drive clamping with optional logging of out-of-bounds violations (toFixed(3) format), clampAllDrives() to mutate an entire drive state object in order via DRIVE_INDEX_ORDER, and checkBounds() for diagnostic reporting of violations with excess magnitude calculation. All functions guard against tuning issues in accumulation rates or cross-modulation coefficients by warning on any clamp event. Logging defaults to process.stderr if no logger provided.

- **Exports:** `isWithinBounds`, `clampDrive`, `clampAllDrives`, `checkBounds`
- **Key constants:** `DRIVE_RANGE.min=-10.0`, `DRIVE_RANGE.max=1.0`
- **Deps:** `@sylphie/shared (DriveName, DRIVE_RANGE, DRIVE_INDEX_ORDER, clampDriveValue)`
- **Gotchas:** Relies on clampDriveValue() from shared (implementation not in this file); DRIVE_INDEX_ORDER iteration order is load-bearing for consistent state mutation; checkBounds() excess calculation is directional (value - max or min - value) to distinguish direction of overage

#### cross-modulation.spec.ts
*test* — Unit test suite for cross-modulation rule engine ensuring individual rules fire correctly and cascade in sequence

Tests the core rule application logic for drive modulation: 5 active rules in the registry (satisfaction-suppresses-boredom, anxiety-amplifies-integrity, system-health-amplifies-anxiety, boredom-amplifies-curiosity, guilt-suppresses-satisfaction). Three rule modes are tested: multiplicative (target *= (1 - coefficient * source)), additive (target += coefficient * source), and additive_gap (target += coefficient * (source - threshold)). Each rule has a threshold value (e.g., satisfaction threshold 0.6, anxiety threshold 0.7) below which it does not fire. The test suite verifies threshold gating, mode behavior with specific coefficients (0.03 for multiplicative, 0.0012 for anxiety-integrity, 0.003 for gap rules), cascading effects where one rule's output becomes another's input (e.g., boredom suppressed by satisfaction, then that suppressed value triggers curiosity), and behavioral equivalence with the pre-refactor procedural implementation.

- **Key constants:** `satisfaction-suppresses-boredom threshold=0.6, coefficient=0.03 (multiplicative)`, `anxiety-amplifies-integrity threshold=0.7, coefficient=0.0012 (additive)`, `system-health-amplifies-anxiety threshold=0.7, coefficient=0.003 (additive_gap)`, `boredom-amplifies-curiosity threshold=0.6, coefficient=0.003 (additive_gap)`, `guilt-suppresses-satisfaction threshold=0.4, coefficient=0.03 (multiplicative)`
- **Deps:** `@sylphie/shared (DriveName enum)`, `./cross-modulation (applyCrossModulation, applyRule, CROSS_MODULATION_RULES, CrossModulationRule type)`
- **Gotchas:** Jest mock of verboseFor() suppresses test logging; test assumes rule execution order matters for cascading (Rule 1 must execute before Rule 4 to test cascading boredom suppression); no tests for clamping/saturation to [0,1] bounds after modifications; no tests for edge-case ordering where different rule orders produce different final states beyond the documented boredom->curiosity cascade

#### cross-modulation.ts
*module* — Models inter-drive dynamics through declarative cross-modulation rules that produce behavioral complexity from simple per-drive updates.

Defines five active cross-modulation rules applied in priority order after individual drive updates but before clamping. Rules fire when a source drive exceeds a threshold and apply effects (multiplicative suppression, additive amplification, or gap-proportional) to target drives: satisfaction suppresses boredom (coeff 0.03, ~37% reduction over 60s at max), anxiety amplifies integrity (coeff 0.0012, ~2x base rate at anxiety=1.0), systemHealth pressure amplifies anxiety via gap (coeff 0.003), boredom amplifies curiosity via gap (coeff 0.003), guilt suppresses satisfaction (coeff 0.03). SystemHealth is recomputed last as mean(MoralValence, Integrity, CognitiveAwareness) to reflect post-modulation state; anxiety rule reads previous tick's composite to prevent feedback loops. Rules modify drive state in place; applyRule returns an effect record for logging.

- **Exports:** `CrossModulationMode`, `CrossModulationRule`, `CrossModulationEffect`, `CROSS_MODULATION_RULES`, `applyRule`, `applyCrossModulation`
- **Key constants:** `CROSS_MODULATION_RULES=[5 rules]`, `threshold-satisfaction=0.6`, `threshold-anxiety=0.7`, `threshold-systemHealth=0.7`, `threshold-boredom=0.6`, `threshold-guilt=0.4`, `coefficient-satisfaction-suppression=0.03`, `coefficient-anxiety-amplification=0.0012`, `coefficient-systemHealth-amplification=0.003`, `coefficient-boredom-amplification=0.003`, `coefficient-guilt-suppression=0.03`
- **Deps:** `@sylphie/shared (DriveName, verboseFor)`
- **Gotchas:** SystemHealth rule fires based on PREVIOUS tick's composite value (deliberate one-tick lag to prevent feedback loops); clamping not applied in this module, deferred to caller; anxiety-to-curiosity suppression rule was removed (noted as semantically wrong)

#### database-clients.ts
*module* — Fallback and future IPC adapters for reading KG(Self) in the isolated Drive Engine child process.

Two classes implement ISelfKgReader: FallbackSelfKgReader (Phase 1, returns empty/null) and IPCSelfKgReader (future, IPC-based stub). Both provide queryCapabilities(), queryDrivePatterns(drive), queryPredictionAccuracy(domain), isReady(). FallbackSelfKgReader has ready=true and enable/disable methods for testing. Global singleton getOrCreateSelfKgReader() returns FallbackSelfKgReader until Phase 2 switches to IPC. CANON §E4-T008 specifies KG(Self) reads every 10 ticks on slower timescale. Phase 1 returns neutral data (empty arrays, null) to allow self-evaluation loop to run without baseline adjustment.

- **Exports:** `FallbackSelfKgReader`, `IPCSelfKgReader`, `getOrCreateSelfKgReader`, `setSelfKgReader`, `resetSelfKgReader`
- **Key constants:** `SELF_KG_QUERY_TIMEOUT_MS (imported)`, `FallbackSelfKgReader.ready=true`, `IPCSelfKgReader.ready=false`
- **Deps:** `../interfaces/self-kg.interfaces`, `@sylphie/shared`, `../constants/self-evaluation`
- **Gotchas:** Both reader classes are stubs: queryCapabilities/queryDrivePatterns/queryPredictionAccuracy return empty arrays or null; IPCSelfKgReader constructor sets ready=false and never initializes IPC; multiple TODOs for Phase 2 IPC implementation and Grafeo query integration via IPC fallback; no actual Grafeo access in Phase 1, allows evaluation loop to run with zero baseline adjustment.

#### default-affect.ts
*module* — Fallback affect computation when no custom Drive Engine rules match an incoming action outcome.

Single exported function getDefaultAffect() wraps computeDefaultAffect() from constants/rules.ts. Takes an ActionOutcomePayload (action completion signal with outcome-level metadata), uses the actionType/procedure category to look up base relief values from rule defaults, layers outcome-level bonuses from guardian feedback, handles metadata-scaled signals (sensory, scene) using counts and magnitudes. Returns a Partial<Record<DriveName, number>> map of drive effects, or empty map if no default rule exists for the action. Part of CANON §Subsystem 4 (Drive Engine) step 3 fallback path; actions without any matching default are flagged for rule debate (internal rule-proposal process for guardian review).

- **Exports:** `getDefaultAffect`
- **Deps:** `@sylphie/shared (ActionOutcomePayload, DriveName)`, `../constants/rules (computeDefaultAffect)`
- **Gotchas:** Logic is completely delegated to computeDefaultAffect() in constants/rules.ts — this file is a thin wrapper; actual algorithm, rule defaults, and outcome bonus logic live elsewhere. No null-check on payload. No logging or monitoring of rule misses.

#### drive-baseline-adjustment.ts
*module* — Adjusts drive baselines based on self-assessed capabilities to prevent identity lock-in from transient failures.

Exports DriveBaselineAdjustment class which manages per-drive baseline overrides stored in adjustedBaselines map. getBaseline(drive) returns adjusted or default baseline. adjustBaselinesFromCapabilities(capabilities) inspects each capability's successRate and either reduces baseline (if < LOW_CAPABILITY_THRESHOLD by BASELINE_REDUCTION_RATE), recovers it (if >= HIGH_CAPABILITY_THRESHOLD by BASELINE_RECOVERY_RATE), or skips; outputs via stderr. applyGeneralRecovery() gradually restores all adjusted baselines toward defaults via BASELINE_RECOVERY_RATE. getAllAdjustedBaselines() merges adjusted overrides into INITIAL_DRIVE_STATE. getDiagnostics() reports adjusted drives and allAtDefault flag. reset() clears all adjustments. Baselines clamped: [−10.0, default] on reduction, default is lower bound on recovery.

- **Exports:** `DriveBaselineAdjustment`
- **Key constants:** `BASELINE_REDUCTION_RATE (from import, actual value from constants file)`, `BASELINE_RECOVERY_RATE (from import, actual value from constants file)`, `LOW_CAPABILITY_THRESHOLD (from import, actual value from constants file)`, `HIGH_CAPABILITY_THRESHOLD (from import, actual value from constants file)`, `Hardcoded floor: -10.0 (line 86)`
- **Deps:** `@sylphie/shared (DriveName, INITIAL_DRIVE_STATE, PressureVector)`, `../constants/self-evaluation (CAPABILITY_TO_DRIVE_MAP, BASELINE_REDUCTION_RATE, BASELINE_RECOVERY_RATE, LOW_CAPABILITY_THRESHOLD, HIGH_CAPABILITY_THRESHOLD)`, `../interfaces/self-kg.interfaces (SelfCapability)`
- **Gotchas:** No obvious TODOs or stubs. Assumes CAPABILITY_TO_DRIVE_MAP keys are all capabilities; silently skips unknown capabilities. Stderr writes guarded by typeof process check but will log copiously on each tick if capabilities are frequently low or recovering. Comment on line 137 says 'shouldn\'t happen' for above-default adjustment but has fallback decay logic. No explicit bounds on maximum baseline above default.

#### drive-correlation-check.ts
*util* — Validate emotional expressions against actual drive state per CANON Standard 1 (Theater Prohibition)

Exports CorrelationCheckResult interface and checkDriveCorrelation() function that verify directionality of emotional expressions. Pressure expressions (distress, need) are authentic only when drive > 0.2; relief expressions (contentment, calm) are authentic only when drive < 0.3; no-expression is always authentic. Returns structured result with isAuthentic flag, expression type, drive value at time of check, and human-readable reason. Uses const CORRELATION_THRESHOLDS object defining pressure=0.2 and relief=0.3 thresholds. Inauthentic (theatrical) expressions receive zero reinforcement. No side effects; pure function.

- **Exports:** `CorrelationCheckResult`, `CORRELATION_THRESHOLDS`, `checkDriveCorrelation`
- **Key constants:** `CORRELATION_THRESHOLDS.pressure=0.2`, `CORRELATION_THRESHOLDS.relief=0.3`
- **Deps:** `@sylphie/shared (DriveName type)`
- **Gotchas:** None detected; straightforward validation logic

#### drive-engine-import-additions.ts
*config* — Instruction snippet for adding RuleEngine import to drive-process module.

This is a minimal documentation/instruction file containing a single import statement comment and the import itself. It instructs developers to add the RuleEngine import from './rule-engine' after other existing imports in the drive-process module. No classes, functions, or logic defined. No side effects beyond the import itself.

- **Deps:** `./rule-engine`
- **Gotchas:** This file appears to be an instruction artifact rather than active source code—it contains only a comment directive and one import statement. Purpose is unclear; may be a fragment, template, or outdated guidance. No actual implementation logic present.

#### drive-engine.ts
*service* — Core drive computation engine — runs isolated 100Hz tick loop (10ms per tick) in child process, managing 12-drive state and applying outcomes via IPC

DriveEngine is the primary service class that executes the deterministic drive computation in isolation from the main NestJS process. The 12-drive tick loop runs at 100Hz (DRIVE_ENGINE_TICK_INTERVAL_MS=10ms) and follows a fixed sequence per tick: drain outcome queue, apply base accumulation/decay rates, apply action/metrics outcomes, apply cross-modulation, clamp to [-10.0, 1.0], compute totalPressure, publish DRIVE_SNAPSHOT, auto-save checkpoint every 60s, advance tick counter. Key subsystems: DriveStateManager (pressure vector state), RuleEngine (PostgreSQL rule matching + effects), SelfEvaluator (non-blocking evaluation every 10 ticks), ContingencyCoordinator (behavioral contingencies per CANON §A.14), PredictionEvaluator (MAE tracking for opportunities), OpportunityDetector + OpportunityQueue (opportunity signal processing), PlanningPublisher (emit top opportunities every 100 ticks). Theater Prohibition (CANON Standard 1) checked on every ACTION_OUTCOME — if theatrical, reinforcement blocked and event logged. Guardian weighting applied: confirmation 2x, correction 3x. IPC message types handled: ACTION_OUTCOME, SOFTWARE_METRICS, SESSION_START/END. Outcomes propagate via applyOutcome(): rules compute effects (or defaults fallback), optional rule debate proposal, guardian weighting, contingency deltas applied. Hard process kill resilience via periodic auto-save to TimescaleDB (fire-and-forget during tick). Health status tracks tick staleness (>5s = unhealthy) and heap memory vs DRIVE_PROCESS_MAX_MEMORY_MB limit. Tick loop compensated for drift via scheduleTick().

- **Exports:** `DriveEngine`, `getOrCreateEngine`
- **Key constants:** `DRIVE_ENGINE_TICK_INTERVAL_MS=10`, `MAX_TICK_DRIFT_MS`, `DRIVE_PROCESS_MAX_MEMORY_MB`, `MAX_OUTCOME_QUEUE_LENGTH`, `BATCH_SIZE`, `BATCH_TIMEOUT_MS`, `MAX_QUEUE_SIZE`, `DRIVE_TICK_SAMPLE_INTERVAL`, `HEALTH_STATUS_INTERVAL_TICKS`, `EMISSION_INTERVAL_TICKS`, `EMISSION_MAX_PER_CYCLE`, `DECAY_CHECK_INTERVAL_TICKS`, `AUTO_SAVE_INTERVAL=60 (ticks, ~60s at 100Hz)`
- **Deps:** `@sylphie/shared (DriveSnapshot, DriveName, computeTotalPressure, verboseFor, DriveIPCMessage types)`, `DriveStateManager`, `getDriveUpdateRates, validateRates`, `clampAllDrives`, `applyCrossModulation`, `RuleEngine`, `SelfEvaluator`, `ContingencyCoordinator`, `PredictionEvaluator`, `OpportunityDetector`, `OpportunityQueue`, `PlanningPublisher`, `EventEmitter`, `TimescaleWriter`, `detectTheater`, `logTheaterProhibition`, `getDefaultAffect`, `generatePredictionOpportunitySignal, shouldEmitOpportunitySignal`, `checkGraduation, checkDemotion`, `applyDecay`
- **Gotchas:** TimescaleWriter optional but recommended for state persistence across hard kills. SessionEnd handler is no-op (final snapshot published on next regular tick). eventEmitter initialized to null but never assigned after construction — appears unused. checkGraduation, checkDemotion imported but never called in tick loop. SelfEvaluator.evaluate() is fire-and-forget (non-blocking) but errors logged to console. Rule debate (proposeRuleForDebate) also fire-and-forget. Opportunity emission only occurs every 100 ticks (EMISSION_INTERVAL_TICKS), creating ~100ms batching delay. Theater prohibition verdict blocks reinforcement entirely with no partial credit. Outcome queue depth only warned at runtime, no hardening for extreme backlog. Clamping occurs on mutable reference (currentState) in-place, not defensive copy.

#### drive-process-manager.service.ts
*service* — Bridges main NestJS process to isolated Drive Engine child via WebSocket IPC; manages lifecycle, health, and event forwarding.

DriveProcessManagerService (implements IDriveProcessManager) manages the Drive Engine child process connection using WebSocket (WsChannelService) instead of child_process.fork(). Lifecycle: start() connects to Drive Engine at wsUrl (default ws://localhost:3001), attaches message handlers, starts health monitoring, and waits for initial health check (2000ms timeout). stop() shuts down health monitor, closes WS gracefully (5s timeout), and flags started=false. isHealthy() delegates to wsChannel.isHealthy(). Message handlers forward DRIVE_SNAPSHOT to DriveReaderService, write OPPORTUNITY_CREATED events to TimescaleDB (events table) for Planning subsystem polling (has_planned=false), log DRIVE_EVENT/HEALTH_STATUS internally. Critical constants: DRIVE_ENGINE_WS_URL (config, default ws://localhost:3001), health check timeout 2000ms, shutdown timeout 5000ms, polling interval 100ms. Fire-and-forget writes to events table; errors logged but not thrown. CANON §Drive Isolation: sole bridge between main and child; no message mutation.

- **Exports:** `DriveProcessManagerService`
- **Key constants:** `DRIVE_ENGINE_WS_URL=ws://localhost:3001`, `INITIAL_HEALTH_CHECK_TIMEOUT=2000ms`, `SHUTDOWN_TIMEOUT=5000ms`, `POLL_INTERVAL=100ms`, `EVENT_TABLE=events`, `EVENT_TYPE=OPPORTUNITY_DETECTED`, `SUBSYSTEM=DRIVE_ENGINE`, `SESSION_ID=drive-engine-internal`, `SCHEMA_VERSION=1`
- **Deps:** `@nestjs/common`, `@nestjs/config`, `@sylphie/shared (DriveIPCMessage, DriveIPCMessageType, DriveSnapshotPayload, TimescaleService, OpportunityCreatedPayload)`, `./drive-reader.service (DriveReaderService)`, `./ipc-channel/ws-channel.service (WsChannelService)`, `./ipc-channel/health-monitor (HealthMonitor)`, `./ipc-channel/recovery (RecoveryMechanism)`, `../interfaces/drive-engine.interfaces (IDriveProcessManager)`
- **Gotchas:** TODO: DRIVE_EVENT forwarding to event backbone not yet implemented (line 201); fire-and-forget opportunity writes silently swallow errors; initial health check non-blocking (warns but doesn't fail start if server down); WS reconnection entirely delegated to RecoveryMechanism

#### drive-state.ts
*module* — Mutable drive state manager for the Drive Engine tick loop — accumulates, decays, and applies outcomes to the 12 drives.

Exports MutableDriveState interface (12 named drive fields) and DriveStateManager class. Manager maintains current/previous state copies, provides applyRates() to add decay/accumulation per drive (negative rates only decay from >0, respecting 0.0 equilibrium), applyOutcomeEffects() to apply partial drive deltas, applyDelta() for single-drive edits, clampAll() to enforce [-10.0, 1.0] bounds with stderr warnings on tuning issues, computeDeltas() to diff current-previous, and freezeCurrent() to produce immutable PressureVector. advanceTick() shifts current→previous for next iteration. Drives are: SystemHealth, MoralValence, Integrity, CognitiveAwareness, Guilt, Curiosity, Boredom, Anxiety, Satisfaction, Sadness, Focus, Social. Decay only applies when drive > 0 (prevents resting drives from going below 0.0). Verbose logging fired via verboseFor() at thresholds >= 0.001.

- **Exports:** `MutableDriveState`, `DriveStateManager`
- **Key constants:** `DRIVE_CLAMP_MIN=-10.0`, `DRIVE_CLAMP_MAX=1.0`, `RATE_LOG_THRESHOLD=0.001`
- **Deps:** `@sylphie/shared: DriveName, DRIVE_INDEX_ORDER, PressureVector, PressureDelta, INITIAL_DRIVE_STATE, clampDriveValue, verboseFor`
- **Gotchas:** Decay (negative rates) silently skips if current drive <= 0 to prevent pushing resting state below equilibrium; clampAll() writes to stderr instead of returning — blocks state below -10.0 and above 1.0 with warning. getCurrentMutable() returns live reference (used for in-place mutations by cross-modulation). No validation that effects/rates sum to zero or stay in bounds before clamping.

#### event-emitter.ts
*service* — Fire-and-forget event emitter for Drive Engine child process with batched TimescaleDB writes.

Exports IEventEmitter interface and EventEmitter class. IEventEmitter defines fire-and-forget methods: emitTick, emitOutcomeProcessed, emitOpportunityCreated, emitContingency, emitSelfEvaluation, emitRuleApplied, emitHealthStatus, and flush(). EventEmitter implements the interface using an internal queue with batching logic. Queue is flushed when it reaches batchSize (default 50) or after batchTimeoutMs (default 100). maxQueueSize defaults to 10000; overflow drops oldest event with stderr warning. All emit methods construct typed events and call private enqueue(). Flush drains queue and writes batch to TimescaleDB via ITimescaleWriter.writeBatch(). Batching is non-blocking: fire-and-forget with setImmediate and setTimeout. Runs only in Drive Engine child process with isolated TimescaleDB connection per CANON §Drive Isolation.

- **Exports:** `IEventEmitter`, `EventEmitter`, `ITimescaleWriter`
- **Key constants:** `batchSize=50`, `batchTimeoutMs=100`, `maxQueueSize=10000`
- **Deps:** `@sylphie/shared (DriveSnapshot, DriveName)`, `../interfaces/drive-events (DriveTickEvent, OutcomeProcessedEvent, OpportunityCreatedEvent, ContingencyAppliedEvent, SelfEvaluationRunEvent, RuleAppliedEvent, HealthStatusEvent, DriveEvent)`
- **Gotchas:** Queue overflow silently drops oldest event (line 220); stderr write depends on process.stderr availability. Errors in batch flush are caught and logged to stderr but do not propagate (fire-and-forget pattern may hide persistent failures). Timer-based batching uses setTimeout and setImmediate without explicit cleanup on process exit.

#### graduation-criteria.ts
*service* — Type 1/Type 2 behavior graduation and demotion decision logic for the Drive Engine

Implements the CANON Type 1/Type 2 Discipline: evaluates when reflexive graph-based behaviors (Type 1) can graduate from LLM-deliberative (Type 2) based on confidence and prediction accuracy. Exports checkGraduation() which passes only if confidence > 0.80 AND MAE < 0.10 (both thresholds imported from constants). Exports checkDemotion() which triggers if MAE > 0.15, reverting Type 1 to Type 2 when prediction accuracy degrades. Both functions return structured results with detailed reason strings and log decisions via verboseFor(). No side effects to DB/network/graph; pure evaluation layer.

- **Exports:** `checkGraduation`, `checkDemotion`, `GraduationCheckResult`, `DemotionCheckResult`
- **Key constants:** `GRADUATION_CONFIDENCE_THRESHOLD = 0.80 (from import)`, `GRADUATION_MAE_THRESHOLD = 0.10 (from import)`, `DEMOTION_MAE_THRESHOLD = 0.15 (from import)`
- **Deps:** `@sylphie/shared (verboseFor)`, `../constants/prediction-evaluation (GRADUATION_CONFIDENCE_THRESHOLD, GRADUATION_MAE_THRESHOLD, DEMOTION_MAE_THRESHOLD)`

#### main.ts
*service* — Standalone child process entry point for isolated DriveEngine tick loop communicating with parent NestJS app via IPC.

This is the executable entry point forked by child_process.fork() from the main process. It instantiates IpcTransport for message routing, calls getOrCreateEngine() to get a singleton DriveEngine instance, and starts the tick loop. The engine itself handles IPC message routing internally. Graceful shutdown handlers trap SIGTERM and SIGINT to call engine.stop() and exit cleanly. Enforces CANON §Drive Isolation: the process is completely isolated, standalone Node.js with its own event loop, not a NestJS module. Uses verboseFor() logging from @sylphie/shared.

- **Deps:** `@sylphie/shared`, `./drive-engine (getOrCreateEngine)`, `./message-transport (IpcTransport)`

#### message-transport.ts
*service* — Transport abstraction layer decoupling DriveEngine from underlying communication mechanism (IPC vs WebSocket)

Defines IMessageTransport interface with send() and onMessage() methods for DriveIPCMessage envelopes. Enforces one-way communication boundary per CANON §Drive Isolation: engine sends snapshots/events outbound, receives outcomes/metrics inbound. Implements IpcTransport (legacy fork-based using process.send/on) as fallback. Transport mechanism is pluggable—engine never knows if messages travel IPC, WebSocket, TCP, or other. Single onMessage handler supported; subsequent registrations replace previous. send() is fire-and-forget; transport handles buffering/retry.

- **Exports:** `IMessageTransport`, `IpcTransport`
- **Deps:** `@sylphie/shared (DriveIPCMessage type)`
- **Gotchas:** IpcTransport has runtime checks for process.send/on presence but no error handling if send fails; fire-and-forget semantics mean no acknowledgment of delivery

#### opportunity-decay.ts
*util* — Decays opportunity priority as prediction MAE improves, removing stale opportunities to prevent runaway attractor states.

Exports applyDecay(), which iterates through opportunities and checks their prediction type's current MAE against DECAY_MAE_THRESHOLD. When MAE drops below threshold, consecutiveGoodPredictions increments; on first occurrence, priority is multiplied by DECAY_PRIORITY_REDUCTION (0.5); after consecutiveGoodPredictions >= DECAY_REMOVAL_CONSECUTIVE_THRESHOLD, the opportunity is filtered out and removed. If MAE exceeds threshold again, the counter resets. Uses verboseFor logging to track priority reductions and removals. Implements CANON Known Attractor States rule to prevent opportunity runaway.

- **Exports:** `applyDecay`
- **Key constants:** `DECAY_MAE_THRESHOLD`, `DECAY_PRIORITY_REDUCTION`, `DECAY_REMOVAL_CONSECUTIVE_THRESHOLD`
- **Deps:** `./prediction-evaluator`, `./opportunity`, `../constants/opportunity-detection`, `@sylphie/shared`
- **Gotchas:** consecutiveGoodPredictions is mutated in-place on opportunity objects; relies on external constants for thresholds; no fallback if evaluator.getMAE() returns undefined.

#### opportunity-detector.spec.ts
*test* — Unit tests for OpportunityDetector classification, deduplication, and registry eviction.

Comprehensive test suite for OpportunityDetector covering: (1) classification logic for RECURRING (failure count >= threshold), HIGH_IMPACT (MAE > 0.40 or totalPressure > 0.8), and LOW_PRIORITY signals; (2) deduplication ensuring duplicate predictionTypes update existing opportunities rather than creating new entries; (3) MAX_REGISTRY_SIZE cap enforcement with oldest-entry eviction when limit exceeded; (4) registry CRUD operations (getByPredictionType, removeByPredictionType, removeOpportunity). Helper createSignal() generates PredictionOpportunitySignal objects with configurable MAE and severity. Mock evaluator returns fixed MAE=0.35, classification=POOR. Key thresholds exercised: RECURRING_FAILURE_THRESHOLD (sampleCount >= 3), MAE threshold 0.40 for HIGH_IMPACT, totalPressure threshold 0.80. Detector state reset per test via beforeEach (sessionNumber=5, totalPressure=0.5).

- **Key constants:** `RECURRING_FAILURE_THRESHOLD=3`, `HIGH_IMPACT_MAE=0.40`, `MEDIUM_SEVERITY_MAE=0.30`, `HIGH_IMPACT_PRESSURE=0.80`, `DEFAULT_SESSION_NUMBER=5`, `DEFAULT_TOTAL_PRESSURE=0.5`
- **Deps:** `OpportunityDetector`, `MAX_REGISTRY_SIZE`, `PredictionOpportunitySignal`, `PredictionEvaluator`, `@sylphie/shared`
- **Gotchas:** No exports or runtime implementation — test-only file. jest.mock suppresses verboseFor logging. createMockEvaluator returns hardcoded MAE=0.35 for all calls, which may mask real threshold behavior if test expectations drift from actual evaluator range.

#### opportunity-detector.ts
*module* — Pattern classification and de-duplication registry for opportunity signals from the prediction evaluator

Implements OpportunityDetector class that receives PredictionOpportunitySignal from PredictionEvaluator and classifies them into three categories: RECURRING (failure count >= 3), HIGH_IMPACT (MAE > 0.40 OR totalPressure > 0.8), and LOW_PRIORITY. Maintains a Map-based registry keyed by predictionType with automatic LRU eviction when size exceeds MAX_REGISTRY_SIZE. De-duplicates signals for the same predictionType by updating priority/metadata instead of creating duplicates (controlled by DEDUPLICATION_ENABLED flag). Exported singleton factory getOrCreateOpportunityDetector() provides global access. Key thresholds: RECURRING_FAILURE_THRESHOLD=3, HIGH_IMPACT_MAE_THRESHOLD=0.40, HIGH_IMPACT_PRESSURE_THRESHOLD=0.8. Side effects: maintains internal registry state, logs all signal processing via vlog.

- **Exports:** `OpportunityDetector`, `getOrCreateOpportunityDetector`
- **Key constants:** `RECURRING_FAILURE_THRESHOLD=3 (from constants)`, `HIGH_IMPACT_MAE_THRESHOLD=0.40 (from constants)`, `HIGH_IMPACT_PRESSURE_THRESHOLD=0.8 (from constants)`, `DEDUPLICATION_ENABLED (from constants)`, `MAX_REGISTRY_SIZE (from constants)`
- **Deps:** `@sylphie/shared (verboseFor)`, `./prediction-evaluator`, `./opportunity-signal`, `../constants/opportunity-detection`, `./opportunity`, `./opportunity-priority`
- **Gotchas:** Line 78: failureCount computed as maeResult.sampleCount (not actual failure count but prediction window sample size); de-duplication relies on DEDUPLICATION_ENABLED flag which could be disabled; Lines 102,125,133: guardianTriggered hardcoded false with TODO comment indicating future signal extraction; registry eviction uses Map insertion-order iteration (oldest-first) which depends on JS Map semantics.

#### opportunity-priority.ts
*module* — Priority scoring for opportunities in the drive engine

Exports two functions: computePriority() computes a priority score for an opportunity using the formula base_priority = log(frequency + 1) * magnitude, then applies cold-start dampening (sessions 1-10 scaled by sessionNumber / COLD_START_SESSION_COUNT) and guardian asymmetry (2x multiplier if guardianTriggered). updateOpportunityPriority() updates an existing opportunity record with new failure count and MAE, recomputes priority, and mutates the opportunity object with new values and timestamp. Both implement CANON §E4-T010 priority semantics. No direct side effects beyond in-memory object mutation.

- **Exports:** `computePriority`, `updateOpportunityPriority`
- **Key constants:** `Guardian asymmetry multiplier = 2.0`
- **Deps:** `../constants/opportunity-detection (COLD_START_SESSION_COUNT)`, `./opportunity (Opportunity type)`
- **Gotchas:** None observed; clean implementation

#### opportunity-queue.spec.ts
*test* — Unit tests for OpportunityQueue eviction and cap behaviour

Test suite covering OpportunityQueue behavior under capacity constraints. Tests verify: (1) normal add below cap returns true, (2) hard-cap eviction when newcomer priority strictly exceeds tail priority, (3) hard-cap rejection when newcomer priority <= tail priority, (4) guardianTriggered items are treated by queue as normal items (scorer responsible for elevated priority), (5) queue maintains sorted order (highest priority first) after eviction, (6) existing API (getTop, remove, size, getAll, replaceAll) continues working correctly. Hard cap is MAX_QUEUE_SIZE=50. Key control flow: add() compares newcomer priority to tail priority; strict inequality required (ties rejected). guardianTriggered flag has no special queue treatment — priority value is what matters. Test helpers: makeOpp() factory creates Opportunity objects with configurable priority and guardianTriggered flag; custom test runner (describe/it) with pass/fail counters and env-gated verbose logging. No DB/network/FS writes; pure in-memory data structure testing.

- **Key constants:** `MAX_QUEUE_SIZE=50`
- **Deps:** `node:assert/strict`, `./opportunity-queue.js`, `./opportunity.js`
- **Gotchas:** SYLPHIE_VERBOSE env var controls logging but no action taken in test code (gated by module import); custom test runner format (not Jest/Mocha); runs via tsx directly; no mock isolation — module already imported before verboseFor patching attempt

#### opportunity-queue.ts
*service* — Priority queue for active opportunities, maintaining sorted order and bounded capacity

OpportunityQueue class maintains opportunities sorted by priority (highest first) with hard-cap eviction at MAX_QUEUE_SIZE. add() compares newcomers against the tail; if higher priority, evicts tail and inserts newcomer, else rejects immediately (fast-path). Key methods: add(opp), getTop(n), remove(id), size(), getAll(), replaceAll() for decay circuit integration. Uses descending sort (b.priority - a.priority). All operations logged via verboseFor(DriveEngine) with priority values fixed to 4 decimals.

- **Exports:** `OpportunityQueue`
- **Key constants:** `MAX_QUEUE_SIZE (imported from constants)`
- **Deps:** `@sylphie/shared (verboseFor)`, `./opportunity (Opportunity type)`, `../constants/opportunity-detection (MAX_QUEUE_SIZE)`
- **Gotchas:** No explicit documentation of MAX_QUEUE_SIZE literal value; replaceAll() is used by decay circuit (unstubbed). Priority comparison uses <= for rejection (tail.priority matched, not exceeded). vlog calls toFixed(4) on priorities—numeric formatting dependency.

#### opportunity-signal.ts
*module* — Generate opportunity signals from prediction accuracy failures to feed Planning subsystem via IPC.

Exports PredictionOpportunitySignal interface (id, type, predictionType, mae, recentFailures, severity, createdAt, contextFingerprint) and three functions: generatePredictionOpportunitySignal() computes severity (low/medium/high) based on MAE thresholds (0.30=medium, 0.40=high) and counts recent failures above MAE_MODERATE_THRESHOLD, returning null for LOW severity; shouldEmitOpportunitySignal() filters to emit only MEDIUM/HIGH via IPC to avoid Planning queue spam; generateId() creates unique UUIDs. Key control flow: signals generated only when mae >= MAE_MODERATE_THRESHOLD (0.20), then severity re-evaluated at 0.30/0.40 boundaries. IPC emission gated to severity >= MEDIUM per CANON §Subsystem 5 (Planning).

- **Exports:** `PredictionOpportunitySignal`, `generatePredictionOpportunitySignal`, `shouldEmitOpportunitySignal`
- **Key constants:** `MAE_MODERATE_THRESHOLD=0.20 (imported)`, `severity thresholds: 0.30 (medium), 0.40 (high)`
- **Deps:** `crypto.randomUUID`, `@sylphie/shared.verboseFor`, `../constants/prediction-evaluation.MAE_MODERATE_THRESHOLD`
- **Gotchas:** None detected. Function returns null for LOW severity signals; caller must handle. MAE_MODERATE_THRESHOLD value not defined inline (imported from constants). Severity assignment logic has no edge-case handling (all mae >= 0.40 -> high, no upper bound check).

#### opportunity.ts
*type* — Core data structure representing detected patterns that merit Planning intervention in the Drive Engine

Defines OpportunityClassification type (RECURRING|HIGH_IMPACT|LOW_PRIORITY) and Opportunity interface with 14 fields: id (UUID), predictionType, classification, mae (mean absolute error), failureCount, priority (decayed over time), sessionNumber, totalPressure, guardianTriggered flag, createdAt/updatedAt timestamps, consecutiveGoodPredictions counter, and contextFingerprint for deduplication. Exports createOpportunity() factory function that initializes a new Opportunity with computed contextFingerprint format "prediction_failure_{predictionType}_mae_{mae.toFixed(2)}" and default priority=0 (computed later by priority scorer). generateOpportunityId() wrapper uses crypto.randomUUID().

- **Exports:** `OpportunityClassification`, `Opportunity`, `createOpportunity`
- **Deps:** `crypto.randomUUID`
- **Gotchas:** priority field initialized to 0 and noted as computed later; no validation of input parameters; consecutiveGoodPredictions tracking mechanism exists but computation logic not shown in this file

#### planning-publisher.ts
*service* — Emit drive opportunities to Planning subsystem via IPC transport.

PlanningPublisher class emits OPPORTUNITY_CREATED messages for opportunities to the Planning subsystem through a configured transport. publishOpportunities() iterates over pre-sorted opportunities and wraps each in a DriveIPCMessage, mapping opportunity classifications (RECURRING -> PREDICTION_FAILURE_PATTERN, HIGH_IMPACT -> HIGH_IMPACT_ONE_OFF, else PREDICTION_FAILURE_PATTERN) and priorities (RECURRING -> HIGH, HIGH_IMPACT -> MEDIUM, else LOW). Includes affectedDrive hardcoded to 'cognitiveAwareness'. Singleton getOrCreatePlanningPublisher() manages global instance. Rate-limited comment claims max 5 opportunities per 100 ticks (~1 second), but no rate-limit logic present in code. All errors caught and logged to console.

- **Exports:** `PlanningPublisher`, `getOrCreatePlanningPublisher`
- **Key constants:** `DriveIPCMessageType.OPPORTUNITY_CREATED`
- **Deps:** `@sylphie/shared (verboseFor, DriveIPCMessage, DriveIPCMessageType, OpportunityCreatedPayload)`, `./opportunity (Opportunity type)`, `./message-transport (IMessageTransport)`
- **Gotchas:** Hardcoded affectedDrive='cognitiveAwareness' as any (type-unsafe). sourceEventId always ''. Rate-limit mentioned in header (max 5 per 100 ticks) but not implemented in code. Classification mapping is lossy (3 input types -> 2 output types). No validation of opportunity data before sending.

#### prediction-evaluator.spec.ts
*test* — Unit tests for PredictionEvaluator — prediction counter, MAE computation, and opportunity severity classification.

Tests the PredictionEvaluator class across six concerns: (1) predictionCount increments on recordPrediction() calls and is reflected in getDebugInfo().totalPredictions, (2) clear() resets predictionCount to 0 and typesCounted, (3) MAE computation returns INSUFFICIENT_DATA for fewer than 3 predictions, ACCURATE for low-error types (MAE ~0.01), POOR for high-error types (MAE ~0.4), (4) rolling window maintenance with 10-prediction buffer that drops oldest predictions, (5) getOpportunitySeverity() returns null for accurate types and a severity string (low/medium/high) for poor predictions, (6) getDebugInfo() aggregates totalPredictions, typesCounted, and typeDetails array with windowSize per action type. Uses Jest mock to suppress @sylphie/shared verboseFor logging.

- **Deps:** `./prediction-evaluator`
- **Gotchas:** Mocks @sylphie/shared verboseFor globally; reliance on exact MAE threshold logic for classification (ACCURATE/POOR/INSUFFICIENT_DATA not explicitly exposed in tests)

#### prediction-evaluator.ts
*service* — Evaluates prediction accuracy per action type using rolling-window MAE; gates graduation/demotion/opportunity signals.

PredictionEvaluator singleton tracks prediction outcomes in-memory, maintaining a rolling window of 10 predictions per action type. recordPrediction() records outcome (predicted/actual), computes absolute error, stores in window, invalidates cache. getMAE() returns cached or freshly computed Mean Absolute Error with classification (ACCURATE<MAE_ACCURATE_THRESHOLD, MODERATE<MAE_MODERATE_THRESHOLD, POOR, or INSUFFICIENT_DATA if <MIN_SAMPLE_COUNT). getGraduationCandidates() returns action types passing MAE graduation threshold. getOpportunitySeverity() maps MAE to opportunity severity (null if MAE<MAE_MODERATE_THRESHOLD; low/medium/high by OPPORTUNITY_SEVERITY_*_THRESHOLD). Global singleton via getOrCreatePredictionEvaluator(). Uses Date.now() for cache TTL (CACHE_TTL_MS), no external I/O.

- **Exports:** `PredictionEvaluator`, `getOrCreatePredictionEvaluator`
- **Key constants:** `MAE_WINDOW_SIZE=10`, `MAE_ACCURATE_THRESHOLD (imported)`, `MAE_MODERATE_THRESHOLD (imported)`, `GRADUATION_CONFIDENCE_THRESHOLD (imported)`, `GRADUATION_MAE_THRESHOLD (imported)`, `DEMOTION_MAE_THRESHOLD (imported)`, `CACHE_TTL_MS (imported)`, `OPPORTUNITY_SEVERITY_LOW_THRESHOLD (imported)`, `OPPORTUNITY_SEVERITY_MEDIUM_THRESHOLD (imported)`, `MIN_SAMPLE_COUNT (imported)`
- **Deps:** `@sylphie/shared (verboseFor)`, `../constants/prediction-evaluation (threshold constants)`
- **Gotchas:** predictionCount counter exists but actual predictions never read back from storage (line 59-60 comment); only getDebugInfo() uses .size; old write-only Map replaced with counter optimization; cache invalidation on window-fill (MAE_WINDOW_SIZE threshold) may mask stale data if constants imported incorrectly

#### reinforcement-blocking.ts
*module* — Enforce theater prohibition by filtering drive effects from theatrical expressions to zero reinforcement.

Implements CANON Standard 1 (Theater Prohibition): emotional expressions without corresponding drive state receive zero reinforcement. Exports ReinforcementFilterResult interface and two functions: filterEffectsForTheater() checks TheaterVerdict and either passes effects through (isTheatrical=false) or zeroes them out (isTheatrical=true), returning details on what was filtered and why; logTheaterProhibition() formats a diagnostic log message showing action type, expression type, drive name/value, blocked effects, and reason. Uses vlog from @sylphie/shared for verbose logging output. No side effects beyond logging; data-transformation only.

- **Exports:** `ReinforcementFilterResult`, `filterEffectsForTheater`, `logTheaterProhibition`
- **Deps:** `@sylphie/shared (DriveName, ActionOutcomePayload, verboseFor)`, `./theater-prohibition (TheaterVerdict)`
- **Gotchas:** Theater blocking is hard-zero (no contingency applied at all); filteredEffects remains empty in both branches; blockedEffects is populated but all passed to blockedEffects with nothing in filteredEffects, meaning theatrical actions produce no effect deltas anywhere; outcome is recorded but drive state unchanged.

#### rule-application.ts
*module* — Parse and apply DSL-encoded rule effects to drive state during step 3 of CANON §Subsystem 4

Implements effect application for the drive engine's rule system. Three main exports: parseEffect() parses a single effect string (e.g., 'integrity += 0.10') into a structured ParsedEffect with driveName, operator, and value; applyEffects() applies multiple ParsedEffect objects to a drive state accumulator, handling +=, -=, *=, and = operators with special composition logic for multiplicative effects; accumulateRuleEffects() orchestrates parsing of multiple rule effect strings (supporting semicolon-delimited multi-effect DSL like 'anxiety += 0.05; satisfaction -= 0.05') and applies them atomically. The pattern enforces a strict regex: ^(\w+)\s*(=|+=|-=|\*=)\s*([-+]?[\d.]+)$ with validation against the DriveName enum. Multiplicative effects are tracked and applied after additive ones to ensure proper composition.

- **Exports:** `ParsedEffect`, `parseEffect`, `applyEffects`, `accumulateRuleEffects`
- **Deps:** `@sylphie/shared (DriveName)`
- **Gotchas:** parseEffect returns null silently on invalid input (catch-all); multiplicative effects require base value from currentDriveState and apply post-additive; no bounds-checking or drive-state saturation logic (clipping/normalization deferred); multi-effect DSL relies on semicolon splitting with no error-reporting on parse failures

#### rule-cache.ts
*util* — LRU cache for rule matching results to reduce recomputation in drive engine

Implements RuleMatchCache, a Map-backed LRU cache with fixed capacity (default 500 entries). CacheEntry stores matched ruleIds and timestamp. Cache operations: get() returns ruleIds or null and updates LRU order by deleting/re-adding to Map; set() inserts or updates entries, evicting the least-recently-used (first Map key) on capacity overflow; clear() empties the cache when rules are reloaded; size() returns entry count. LRU ordering leverages JavaScript Map iteration order (insertion order). Cache invalidation happens when rules are reloaded from database. No DB/network/FS writes; in-memory only.

- **Exports:** `CacheEntry`, `RuleMatchCache`
- **Key constants:** `maxSize=500`

#### rule-engine.ts
*service* — PostgreSQL-backed rule engine that matches behavioral contingency rules to events and applies effects to drive state.

RuleEngine is the enforcement mechanism for CANON §Subsystem 4 (Drive Engine), step 3. It loads active rules from PostgreSQL drive_rules table on startup and reloads every 60 seconds (RULE_RELOAD_INTERVAL_MS). The core matchAndApply() method: (1) checks RuleMatchCache for cached results by event type + drive state; (2) if cache miss, matches all loaded rules by iterating and evaluating ParsedTrigger via evaluateTrigger(); (3) accumulates matched rule effects as drive deltas; (4) if no rules match, sets usedDefaultAffect=true and lets caller apply default affects via getDefaultAffect(); (5) caches matched rule IDs for future lookups. LoadedRule stores id, triggerPattern, parsedTrigger (cached parse), effect (DSL string), and confidence. Rules below RULE_CONFIDENCE_THRESHOLD are skipped. proposeRuleForDebate() creates entries in proposed_drive_rules table for unmatched action types, deduplicating on (actionType, status='pending'). All DB operations use direct PostgreSQL Pool connection (not NestJS DI). Logging via verboseFor('DriveEngine') for rule matches and via process.stderr for reload operations.

- **Exports:** `RuleEngine`, `RuleApplicationResult`
- **Key constants:** `RULE_RELOAD_INTERVAL_MS=60000 (inferred)`, `RULE_CONFIDENCE_THRESHOLD (from constants/rules)`, `RULE_CACHE_MAX_SIZE (from constants/rules)`
- **Deps:** `@sylphie/shared:DriveName,PressureVector,verboseFor`, `./rule-matching:ParsedTrigger,parseTriggerPattern,evaluateTrigger,generateCacheKey,RuleMatchContext`, `./rule-application:parseEffect,accumulateRuleEffects`, `./rule-cache:RuleMatchCache`, `../constants/rules:RULE_RELOAD_INTERVAL_MS,RULE_CONFIDENCE_THRESHOLD,RULE_CACHE_MAX_SIZE`, `pg:Pool`
- **Gotchas:** getDefaultAffect import stub (line 36-38) indicates legacy event-type-based path is no longer used but kept for compatibility. proposeRuleForDebate() is non-fatal on DB errors (won't break tick loop). reloadTimer.unref() allows process exit despite active timer. Cache is cleared on every rule reload, which may cause temporary cache misses after reload cycles.

#### rule-matching.ts
*util* — Rule pattern matching engine for drive system trigger evaluation

Parses and evaluates rule trigger patterns (e.g., "action_success AND anxiety > 0.7") against incoming events and drive state snapshots. Exports ParsedTrigger and Condition interfaces for structured representation, parseTriggerPattern() to parse pattern strings with AND/OR operators (mixed operators rejected), evaluateTrigger() and evaluateCondition() for matching evaluation. Drive conditions support comparison operators (>, <, =, >=, <=, !=) with numeric thresholds; event conditions do simple string matching. Floating-point equality uses 0.0001 epsilon. generateCacheKey() hashes drive state for result caching, using only four relevant drives (Anxiety, Satisfaction, Guilt, CognitiveAwareness) at 2-decimal precision. Performance target is <5ms for 100 rules. No side effects; pure matching logic.

- **Exports:** `ParsedTrigger`, `Condition`, `RuleMatchContext`, `parseTriggerPattern`, `evaluateTrigger`, `generateCacheKey`
- **Deps:** `@sylphie/shared (DriveName, PressureVector)`
- **Gotchas:** Mixed AND/OR operators in same pattern rejected (returns null). Floating-point equality check uses hardcoded 0.0001 epsilon. Invalid drive names in conditions return null. No logging or error tracking beyond try-catch suppression. Cache key generation hard-codes four drives; other drives ignored by cache.

#### self-evaluation-circuit-breaker.ts
*module* — Circuit breaker to prevent self-evaluation rumination loops and depressive attractor states

Exports CircuitBreakerState enum (CLOSED, OPEN, HALF_OPEN) and SelfEvaluationCircuitBreaker class. The class tracks consecutive negative assessments and pauses self-evaluation when threshold reached. Core methods: isOpen() checks if circuit should skip evaluation (transitions from OPEN to HALF_OPEN after pause duration expires), recordNegativeAssessment() increments counter and trips circuit if threshold met, recordPositiveAssessment() resets counter and closes circuit from HALF_OPEN. tripCircuit() sets state to OPEN and starts pause timer. Thresholds: CIRCUIT_BREAKER_NEGATIVE_THRESHOLD (imported constant) and CIRCUIT_BREAKER_PAUSE_DURATION_MS. Implements three-state pattern: CLOSED (normal), OPEN (paused), HALF_OPEN (recovery window). Writes diagnostics to process.stderr on state transitions.

- **Exports:** `CircuitBreakerState`, `SelfEvaluationCircuitBreaker`
- **Key constants:** `CIRCUIT_BREAKER_NEGATIVE_THRESHOLD (imported)`, `CIRCUIT_BREAKER_PAUSE_DURATION_MS (imported)`
- **Deps:** `../constants/self-evaluation`
- **Gotchas:** No stubs or dead code; state machine assumes Date.now() consistency; process.stderr availability checked before writes; pauseStartedAt is null until circuit trips; HALF_OPEN allows one evaluation to close or reopen circuit

#### self-evaluation.ts
*service* — Self-evaluation subsystem that runs periodically to read KG(Self) and adjust drive baselines to prevent identity lock-in

SelfEvaluator class manages slower-timescale KG(Self) queries and baseline adjustments via DriveBaselineAdjustment. Runs every SELF_EVALUATION_INTERVAL_TICKS (via shouldEvaluate). evaluate() method queries capabilities asynchronously with SELF_KG_QUERY_TIMEOUT_MS timeout, assesses if any capability has successRate < 0.3 as negative, records result in SelfEvaluationCircuitBreaker (which can open to pause self-eval), and adjusts baselines. Implements getOrCreateSelfEvaluator() and setSelfEvaluator() singletons for global instance management. Diagnostic methods provide evaluationCount, lastEvaluationTick, circuitBreakerState, and adjustedBaselines. All errors are caught and logged without crashing the tick loop.

- **Exports:** `SelfEvaluator`, `getOrCreateSelfEvaluator`, `setSelfEvaluator`, `resetSelfEvaluator`
- **Key constants:** `SELF_EVALUATION_INTERVAL_TICKS (imported)`, `SELF_KG_QUERY_TIMEOUT_MS (imported)`, `successRate threshold=0.3`
- **Deps:** `@sylphie/shared (DriveName, DRIVE_INDEX_ORDER, INITIAL_DRIVE_STATE, verboseFor)`, `../constants/self-evaluation`, `../interfaces/self-kg.interfaces`, `./drive-state`, `./drive-baseline-adjustment`, `./self-evaluation-circuit-breaker`, `./database-clients`
- **Gotchas:** selfKgReader.isReady() early-return silently skips evaluation; error during query does not trigger negative assessment record (intentional to distinguish real failures from timeouts/errors); circuit breaker can halt all self-evaluation; diagnostics exposure assumes caller understands circuit breaker state transitions

#### theater-prohibition.ts
*module* — Enforce Theater Prohibition (CANON Standard 1): verify emotional expressions match actual drive state.

Validates that emotional expressions (pressure, relief, or none) correlate with corresponding drive pressures. Provides post-flight verification of theater checks from ACTION_OUTCOME payloads. Key exports: TheaterVerdict interface and detectTheater() function. Two helper functions verifyPressureExpression() and verifyReliefExpression() check directional authenticity against hardcoded thresholds. Logging via verboseFor('DriveEngine'). Theater prohibition requires pressure expressions to have drive > 0.2 and relief expressions to have drive < 0.3; violations return isTheatrical=true with detailed reason.

- **Exports:** `TheaterVerdict`, `detectTheater`
- **Key constants:** `PRESSURE_THRESHOLD=0.2`, `RELIEF_THRESHOLD=0.3`
- **Deps:** `@sylphie/shared (DriveName, ActionOutcomePayload, PressureVector, verboseFor)`
- **Gotchas:** Post-flight verification is secondary; relies on pre-flight check from Communication module. Drive value may change between dispatch and outcome, so post-flight re-validates. No integration with actual reinforcement suppression yet (stub: verdict returned but not wired to reward signals).

#### timescale-writer.ts
*service* — TimescaleDB writer for Drive Engine events with batched inserts, retry logic, and state persistence in isolated child process.

Exports TimescaleWriter class managing a dedicated pg.Pool connection to TimescaleDB isolated from main NestJS process per CANON § Drive Isolation. Core methods: init() verifies connectivity; writeBatch(events) inserts with exponential backoff retry (RETRY_COUNT attempts, RETRY_BASE_DELAY_MS base delay); buildInsertQuery(events) constructs parameterized multi-value INSERT for 8-column events table (event_id, timestamp, event_type, subsystem_source, correlation_id, drive_snapshot, event_data, schema_version); saveState(pressureVector, tickNumber) UPSERT to drive_state_checkpoint table on graceful shutdown; loadState() retrieves checkpoint for restart recovery; ensureCheckpointTable() creates checkpoint table if missing; close() releases pool on shutdown. Generates UUID v4 inline to minimize dependencies in child process.

- **Exports:** `TimescaleWriter`
- **Key constants:** `maxConnections=5`, `idleTimeoutMillis=30000`, `connectionTimeoutMillis=5000`, `8 columns per event in batch insert`, `schema_version=1 for Drive Engine events`
- **Deps:** `pg (Pool, PoolClient)`, `@sylphie/shared (verboseFor)`, `../interfaces/drive-events (DriveEvent)`, `../constants/events (RETRY_COUNT, RETRY_BASE_DELAY_MS)`
- **Gotchas:** UUID generation uses Math.random() (non-cryptographic, noted as production TODO); drive_state_checkpoint table creation is idempotent but error logged on first cold start; all DB errors logged to stderr instead of thrown to avoid crashing child process; writeBatch silently discards events if pool not ready (non-blocking); loadState returns null on table-not-found (treated as cold start)

### `packages/drive-engine/src/drive-process/behavioral-contingencies/`

#### anxiety-amplification.ts
*module* — Implements CANON §A.15 Anxiety Amplification contingency: amplifies negative drive effects and confidence reductions when anxiety is elevated (>0.7) and outcomes are negative, and provides anxiety relief on positive outcomes under stress.

Exports AnxietyAmplification class with two core methods: amplifyReduction() multiplies baseReduction by 1.5x when anxietyAtExecution > 0.7 AND outcome is 'negative', else returns baseReduction unchanged; computeDriveEffects() applies contingency-level effects via ContingencyCoordinator—for negative outcomes, amplifies any positive (pressure-increasing) drive deltas by 50% additional (cumulative 1.5x), returning only the supplemental portion; for positive outcomes under high anxiety, grants ANXIETY_RELIEF_ON_SUCCESS (-0.10) to the Anxiety drive. Uses singleton pattern with getOrCreateAnxietyAmplification(). All logic is Type 1 (no blocking calls), pure arithmetic with verbose logging at key decision points.

- **Exports:** `AnxietyAmplification`, `getOrCreateAnxietyAmplification`
- **Key constants:** `ANXIETY_THRESHOLD=0.7`, `NEGATIVE_AMPLIFICATION_FACTOR=1.5`, `ANXIETY_RELIEF_ON_SUCCESS=-0.10`
- **Deps:** `@sylphie/shared (DriveName, verboseFor)`

#### contingency-coordinator.ts
*module* — Orchestrates all five behavioral contingencies (satisfaction habituation, anxiety amplification, guilt repair, social comment quality, curiosity information gain) and returns aggregated drive effects applied to current drive state.

Exports ContingencyCoordinator class with applyContingencies() as primary entry point, called from DriveEngine.applyOutcome() after theater check. Five contingency modules are instantiated as private fields: satisfactionHabituation, anxietyAmplification, guiltyRepair, socialCommentQuality, curiosityInformationGain. The applyContingencies() method iterates through all five contingencies in order, accumulating drive deltas via an addDelta helper that skips zero values. Anxiety amplification fires on both negative (amplifies pressure-increasing effects by 1.5x) and positive outcomes (provides -0.10 anxiety relief). Social comment quality triggers on presence of socialCommentTimestamp in payload. Curiosity relief degrades gracefully to 0 if informationGainMetrics absent. Singleton pattern via getOrCreateContingencyCoordinator(). Secondary methods recordComment(), processGuardianResponse(), and getAmplifiedConfidenceReduction() provide additional social/WKG integration points. reset() clears contingency state for session start/debugging. All contingencies are Type 1 reflexive (non-blocking).

- **Exports:** `ContingencyCoordinator`, `getOrCreateContingencyCoordinator`
- **Deps:** `@sylphie/shared: DriveName, PressureVector, verboseFor, ActionOutcomePayload`, `./satisfaction-habituation: getOrCreateSatisfactionHabituation`, `./anxiety-amplification: getOrCreateAnxietyAmplification`, `./guilt-repair: getOrCreateGuiltyRepair`, `./social-comment-quality: getOrCreateSocialCommentQuality`, `./curiosity-information-gain: getOrCreateCuriosityInformationGain`
- **Gotchas:** Social contingency evaluateFromOutcome() comment tracking depends on socialCommentTimestamp presence in ActionOutcomePayload; missing timestamp silently skips firing. Anxiety amplification computeDriveEffects() called with empty driveEffects map (effects computed internally elsewhere). Guilt repair passes previousErrorActionType and previousErrorContext both set to actionType (may be placeholder/stub?). curiosityInformationGain.computeReliefFromMetrics() returns 0 gracefully if informationGainMetrics absent. No error handling or validation of outcome/drive states.

#### curiosity-information-gain.ts
*module* — Computes curiosity drive relief based on information gained from learning outcomes.

Implements CANON §A.14 Behavioral Contingency for curiosity drive satisfaction. Exports CuriosityInformationGain class with two public methods: computeRelief() applies the relief formula (newNodes * 0.05 + confidenceDeltas * 0.10 + resolvedErrors * 0.15) and returns negative value for drive reduction; computeReliefFromMetrics() extracts metrics from ActionOutcomePayload and delegates to computeRelief(). Also exports InformationGainMetrics interface, CuriosityInformationGainEffect interface, and singleton accessor getOrCreateCuriosityInformationGain(). Type 1 computation (no blocking calls, pure arithmetic). Gracefully handles missing metrics by defaulting to 0.

- **Exports:** `CuriosityInformationGain`, `InformationGainMetrics`, `CuriosityInformationGainEffect`, `getOrCreateCuriosityInformationGain`
- **Key constants:** `newNodes_weight=0.05`, `confidenceDeltas_weight=0.10`, `resolvedErrors_weight=0.15`
- **Deps:** `@sylphie/shared`
- **Gotchas:** Singleton pattern with null-initialized instance; returns negative relief values (relief = drive reduction); relies on ACTION_OUTCOME context to provide metrics (notes that WKG not yet accessible in child process); graceful degradation if metrics absent or fields missing.

#### guilt-repair.ts
*module* — Implements guilt relief mechanisms through acknowledgment detection and behavioral-change tracking per CANON §A.14.

Exports GuiltyRepair class that computes guilt relief based on action outcomes. Detects acknowledgment via keyword matching (apologize, acknowledge, accept, responsibility, admit, regret, sorry); detects behavioral change by comparing current action type to previous error action type. Relief schedule: acknowledgment only -0.10, behavioral change only -0.15, both -0.30. Maintains in-memory error history (max 10 entries, 15-min timeout) to track recent errors. Provides singleton instance via getOrCreateGuiltyRepair(). Also exports GuiltRepairEffect interface for drive effect mapping.

- **Exports:** `GuiltyRepair`, `GuiltRepairEffect`, `getOrCreateGuiltyRepair`
- **Key constants:** `MAX_ERROR_HISTORY=10`, `ERROR_HISTORY_TIMEOUT_MS=900000`
- **Deps:** `@sylphie/shared (DriveName, verboseFor)`
- **Gotchas:** No external persistence — error history lost on process restart; behavioral-change detection simple string equality (could miss semantic equivalence); no validation that previousErrorActionType is actually recent (relies on caller passing correct context)

#### index.ts
*barrel* — Re-exports five CANON §A.14 reinforcement schedules and their coordinator.

Barrel module that centralizes exports for the behavioral contingencies subsystem. Exports five reinforcement schedule classes (SatisfactionHabituation, AnxietyAmplification, GuiltyRepair, SocialCommentQuality, CuriosityInformationGain) along with their factory functions (getOrCreate* variants) and associated types. Also exports ContingencyCoordinator and getOrCreateContingencyCoordinator. All five schedules are Type 1 (reflexive, non-blocking). These implement CANON §A.14 behavioral contingencies that shape Sylphie's personality through contingency-based learning.

- **Exports:** `SatisfactionHabituation`, `getOrCreateSatisfactionHabituation`, `SatisfactionHabitationEffect`, `AnxietyAmplification`, `getOrCreateAnxietyAmplification`, `GuiltyRepair`, `getOrCreateGuiltyRepair`, `GuiltRepairEffect`, `SocialCommentQuality`, `getOrCreateSocialCommentQuality`, `SocialCommentReliefResult`, `SocialCommentQualityEffects`, `CuriosityInformationGain`, `getOrCreateCuriosityInformationGain`, `InformationGainMetrics`, `CuriosityInformationGainEffect`, `ContingencyCoordinator`, `getOrCreateContingencyCoordinator`
- **Deps:** `./satisfaction-habituation`, `./anxiety-amplification`, `./guilt-repair`, `./social-comment-quality`, `./curiosity-information-gain`, `./contingency-coordinator`

#### satisfaction-habituation.ts
*module* — Tracks consecutive successes on repeated action types with diminishing relief returns (CANON §A.14).

Exports SatisfactionHabituation class managing per-action-type success streaks via in-memory Map. computeRelief(actionType, outcome) returns 0 on failure (resets counter) or habituation curve value on success: 1st=0.05, 2nd=0.04, 3rd=0.03, 4th=0.02, 5-10th=0.01, 11th+=0.005. habituationCurve() applies diminishing returns so ~30 messages reach ~0.5 satisfaction, not spiking after 3. Also exports SatisfactionHabitationEffect interface (drive=Satisfaction, delta=number) and singleton getter getOrCreateSatisfactionHabituation(). reset() clears all state; getState() exposes current per-action-type counters. Type 1 computation — no blocking calls, pure in-memory.

- **Exports:** `SatisfactionHabituation`, `SatisfactionHabitationEffect`, `getOrCreateSatisfactionHabituation`
- **Key constants:** `relief curve: 1st=0.05, 2nd=0.04, 3rd=0.03, 4th=0.02, 5-10th=0.01, 11th+=0.005`
- **Deps:** `@sylphie/shared (DriveName, verboseFor)`
- **Gotchas:** None visible — clean implementation matching CANON spec.

#### social-comment-quality.ts
*module* — Behavioral contingency implementing CANON §A.14: drive relief for guardian-initiated comments with rapid responses

Implements SocialCommentQuality class that tracks Sylphie-initiated comments in a 60-second time-windowed buffer and grants drive relief when the guardian responds within 30 seconds. On positive response, applies social -= 0.15 (relief) and satisfaction += 0.10 (bonus) per qualifying comment. Exports singleton getter getOrCreateSocialCommentQuality() and interfaces SocialCommentReliefResult and SocialCommentQualityEffects. Key methods: recordComment() adds comments to buffer with auto-cleanup, evaluateFromOutcome() bridges action outcomes to relief calculation, processGuardianResponse() checks buffer for qualifying comments and accumulates deltas. Type 1 computation: no blocking calls, pure in-memory state.

- **Exports:** `SocialCommentQuality`, `SocialCommentReliefResult`, `SocialCommentQualityEffects`, `getOrCreateSocialCommentQuality`
- **Key constants:** `COMMENT_BUFFER_TIMEOUT_MS=60000`, `RESPONSE_BONUS_TIMEOUT_MS=30000`, `socialRelief=-0.15`, `satisfactionBonus=0.10`
- **Deps:** `@sylphie/shared (DriveName, verboseFor)`
- **Gotchas:** No persistent storage of comment history; buffer is ephemeral in-memory. singleton instance could be null-checked in tests. Hard-coded relief values (0.15, 0.10) are literal, not configurable.

### `packages/drive-engine/src/drive-reader/`

#### drive-state-snapshot.ts
*util* — Coherence validation for DriveSnapshot IPC boundary before caching

Validates snapshots from the isolated Drive Engine child process before caching. Core exports: validateDriveSnapshotCoherence (validates bounds, initialization state, totalPressure consistency, and staleness); defensiveCopySnapshot (deep JSON copy with Date restoration). Validation checks: (1) all drive values within DRIVE_RANGE [-10.0, 1.0], (2) not all drives zero post-initialization (crash detection), (3) totalPressure matches computed sum with 0.001 tolerance, (4) snapshot not stale (>5s since last valid, accounting for 1Hz tick rate + jitter). Cold-start sentinel epoch detection prevents false staleness at boot. JSON round-trip Date reconstruction ensures type consistency for consumers.

- **Exports:** `CoherenceResult`, `validateDriveSnapshotCoherence`, `defensiveCopySnapshot`
- **Key constants:** `DRIVE_RANGE.min=-10.0`, `DRIVE_RANGE.max=1.0`, `staleness_threshold_ms=5000`, `floating_point_tolerance=0.001`
- **Deps:** `@sylphie/shared (DriveSnapshot, DRIVE_RANGE, computeTotalPressure, DriveCoherenceError)`
- **Gotchas:** Timestamp serialization via JSON.stringify converts Date to ISO string; code reconstructs it post-deserialize. Staleness check skips when lastValidTimestamp is epoch sentinel (getTime() <= 0). Drive value consistency at IPC boundary is the only crash/hang detection point before cache.

### `packages/drive-engine/src/interfaces/`

#### drive-engine.interfaces.ts
*type* — Drive Engine module interface contracts and CANON compliance enforcement for isolated drive computation.

Defines five core interfaces: Opportunity (detected prediction-failure patterns for Planning), ProposedDriveRule (guardian-gated rule modifications), SoftwareMetrics (Type 2 cognitive effort cost tracking), IDriveStateReader (read-only facade with zero write methods per CANON Standard 6), IActionOutcomeReporter (fire-and-forget IPC channel for outcomes/metrics), IRuleProposer (INSERT-only proposed_drive_rules DB interface), and IDriveProcessManager (internal child-process lifecycle management not exported). Key thresholds: Opportunity priority [0.0,1.0], getTotalPressure() result [0.0,12.0], SoftwareMetrics.cognitiveEffortPressure [0.0,1.0]. CANON obligations pervasive: Standard 1 (Theater Prohibition) via theaterCheck payload, Standard 2 (Contingency Requirement) via mandatory actionId, Standard 5 (Guardian Asymmetry ×2/×3 weight), Standard 6 (No Self-Modification—IDriveStateReader has zero writes; IRuleProposer INSERT-only; active rules write-protected). reportOutcome includes metadata (undiscoveredObjectCount, unknownPersonCount, sensoryPredictionError, sceneSurprise, guardianTeachingDrive), feedbackSource (ProvenanceSource), predictionData (predictionId, predictedValue, actualValue), socialCommentTimestamp (30s response window for Social relief bonus). driveState$ Observable target 100Hz emission from child process. INITIAL_DRIVE_STATE used for cold start and resetDriveState().

- **Exports:** `OpportunityClassification`, `Opportunity`, `ProposedDriveRule`, `SoftwareMetrics`, `IDriveStateReader`, `IActionOutcomeReporter`, `IRuleProposer`, `IDriveProcessManager`
- **Deps:** `rxjs`, `@sylphie/shared (DriveSnapshot, DriveName, ProvenanceSource)`
- **Gotchas:** IDriveProcessManager explicitly NOT exported from module barrel—internal only. driveState$ Observable may be 1-2 ticks stale due to IPC latency (acceptable, drives change slowly relative to 100Hz tick). reportOutcome and reportMetrics are fire-and-forget (void); no acknowledgment waits. Drive rule proposals never autonomously approved—guardian tooling copies to active table only.

#### drive-events.ts
*type* — Drive Engine event payload type definitions for audit and cross-subsystem correlation

Defines 7 event interfaces emitted by the isolated Drive Engine child process to TimescaleDB: BaseDriveEvent (base with driveSnapshot, sessionId, timestamp), DriveTickEvent (high-frequency tick snapshots with ruleIds fired and totalPressure), OutcomeProcessedEvent (action evaluation results with outcome positive/negative, appliedRuleIds, driveDelta, wasTheatrical boolean, feedbackSource), OpportunityCreatedEvent (pattern detection for Planning with classification, priority, contextFingerprint, affectedDrive, predictionMAE), ContingencyAppliedEvent (pre-planned rule mappings with ruleId, eventType, driveDelta, confidence 0-1), SelfEvaluationRunEvent (self-model evaluation cycles with evaluationType, result object, hasConcerns flag), RuleAppliedEvent (Postgres drive_rules matches with ruleId, eventType, driveDelta, isGuardianApproved flag), HealthStatusEvent (periodic heartbeat with tickNumber, memoryUsageMb, healthy boolean, diagnosticMessage). All events include drive state snapshot per CANON Standard 1 (Theater Prohibition).

- **Exports:** `BaseDriveEvent`, `DriveTickEvent`, `OutcomeProcessedEvent`, `OpportunityCreatedEvent`, `ContingencyAppliedEvent`, `SelfEvaluationRunEvent`, `RuleAppliedEvent`, `HealthStatusEvent`, `DriveEvent`
- **Key constants:** `DriveTickEvent.type=DRIVE_TICK`, `OutcomeProcessedEvent.type=OUTCOME_PROCESSED`, `OutcomeProcessedEvent.outcome=[positive\|negative]`, `OutcomeProcessedEvent.feedbackSource=[guardian_confirmation\|guardian_correction\|algorithmic]`, `OpportunityCreatedEvent.type=OPPORTUNITY_CREATED`, `OpportunityCreatedEvent.classification=[PREDICTION_FAILURE_PATTERN\|HIGH_IMPACT_ONE_OFF\|BEHAVIORAL_NARROWING\|GUARDIAN_TEACHING]`, `OpportunityCreatedEvent.priority=[HIGH\|MEDIUM\|LOW]`, `ContingencyAppliedEvent.type=CONTINGENCY_APPLIED`, `ContingencyAppliedEvent.confidence=[0.0-1.0]`, `SelfEvaluationRunEvent.type=SELF_EVALUATION_RUN`, `RuleAppliedEvent.type=RULE_APPLIED`, `HealthStatusEvent.type=HEALTH_STATUS`
- **Deps:** `@sylphie/shared (DriveSnapshot, DriveName)`
- **Gotchas:** None identified; clean type definitions with no stubs or TODOs. Sampled emission strategy for DriveTickEvent to avoid flooding TimescaleDB is documented but implemented elsewhere.

#### self-kg.interfaces.ts
*type* — Read-only interface contract for Drive Engine to query KG(Self) graph maintained by Learning subsystem

Defines three data types (SelfCapability, DrivePattern, PredictionAccuracy) and one query interface (ISelfKgReader). SelfCapability tracks skill success rates [0.0, 1.0] with confidence and sample counts; used to adjust drive baselines when success rate drops below 0.3. DrivePattern represents learned stimulus-response associations for specific drives with response strength and historical examples. PredictionAccuracy measures Mean Absolute Error (MAE) of predictions by domain for Integrity drive assessment. ISelfKgReader is the read-only contract with three query methods: queryCapabilities(), queryDrivePatterns(drive), queryPredictionAccuracy(domain), plus isReady() availability check. CANON §E4-T008 mandates Drive Engine reads KG(Self) every 10 ticks (~100ms) to prevent identity lock-in. All data refreshed on each call; Learning subsystem owns all writes.

- **Exports:** `SelfCapability`, `DrivePattern`, `PredictionAccuracy`, `ISelfKgReader`
- **Key constants:** `CANON §E4-T008: 10 ticks (~100ms) read frequency`, `successRate threshold < 0.3 reduces baseline`, `successRate range [0.0, 1.0]`, `responseStrength range [0.0, 1.0]`, `confidence range [0.0, 1.0]`
- **Deps:** `@sylphie/shared (DriveName)`
- **Gotchas:** ISelfKgReader is explicitly read-only; Drive Engine must never write to KG(Self). ISelfKgReader.queryCapabilities() and queryDrivePatterns() return empty arrays if unavailable rather than null. Implementation is a Grafeo adapter in Drive Engine process. No explicit error handling documented for failed queries.

### `packages/drive-engine/src/ipc-channel/`

#### health-monitor.ts
*service* — Periodic health monitoring of Drive Engine child process via heartbeat timeout and snapshot tracking.

Exports HealthMonitor class that performs continuous liveness checks on a child IPC process. Sends periodic checks every 2000ms (configurable), declares process unhealthy if no DRIVE_SNAPSHOT received for >5000ms (configurable). Key methods: start() begins the monitoring loop, stop() halts it and returns final report, getHealthReport() returns current HealthReport with healthy flag, msSinceLastSnapshot, childMemoryBytes (always null in current impl), lastPingAt, and diagnosticMessage. recordSnapshot() resets the heartbeat timer when snapshot arrives (called by DriveProcessManagerService, not registered as onMessage handler to avoid IPC handler collision). performHealthCheck() logs verbosely every interval. HealthReport interface defines the status shape exported to callers.

- **Exports:** `HealthMonitor`, `HealthReport`
- **Key constants:** `checkIntervalMs=2000`, `heartbeatTimeoutMs=5000`
- **Deps:** `@nestjs/common`, `@sylphie/shared`, `./ws-channel.service`
- **Gotchas:** childMemoryBytes hardcoded to null (line 123), never populated; comment says memory monitoring is planned but not implemented. IPC handler design constraint documented (line 88-90) prevents registering own onMessage for DRIVE_SNAPSHOT—relies on external recordSnapshot() call from DriveProcessManagerService, creating coupling risk if caller forgets to wire it.

#### ipc-channel.service.ts
*service* — Manages bidirectional IPC communication lifecycle and message dispatch between main process and Drive Engine child process.

IpcChannelService is a NestJS Injectable that spawns a forked child process (drive-process/main) and manages the message channel between parent and child. Core methods: fork() spawns the child with ts-node/tsconfig-paths loaders in dev mode, attaches message/error/exit handlers, and tracks spawnTime + lastHealthCheckTime + lastTick timestamps; onMessage() registers type-specific handlers in a MessageHandlers map (DRIVE_SNAPSHOT, OPPORTUNITY_CREATED, DRIVE_EVENT, HEALTH_STATUS); send() enqueues messages in a FIFO sendQueue (PendingMessage[]) with optional back-pressure (re-queues on send failure); close(graceMs=5000) sends SIGTERM with grace period fallback to SIGKILL; isHealthy(heartbeatMs=5000) checks if childProcess exists and health metrics are within window; getProcessInfo() returns spawned/pid/uptime/restartCount; incrementRestartCount() increments counter. onChildMessage() validates inbound messages via safeValidateMessage, updates health metrics (lastTick on DRIVE_SNAPSHOT, lastHealthCheckTime on HEALTH_STATUS), then dispatches to registered handler. processSendQueue() drains sendQueue FIFO while childProcess exists, re-queues on send error, gates re-entry with isProcessing flag.

- **Exports:** `IpcChannelService`, `MessageHandler`
- **Key constants:** `heartbeatMs default=5000`, `graceMs default=5000`, `stdio=['inherit','inherit','inherit','ipc']`
- **Deps:** `@nestjs/common`, `child_process`, `path`, `@sylphie/shared`, `./ipc-message-validator`
- **Gotchas:** Uses __dirname relative path (ipc-channel.service.ts → ../drive-process/main) which may be fragile if file structure changes; __filename.ts/.js detection for dev vs compiled mode (relies on execution context); sendQueue messages persist if child crashes — Recovery Mechanism responsible for re-queue on restart; no timeout on message handler execution (could block processSendQueue).

#### ipc-message-validator.ts
*util* — Zod-based validation layer for all DriveIPCMessage payloads crossing the process boundary (main ↔ Drive Engine child).

Defines 8 payload schemas (ACTION_OUTCOME, SOFTWARE_METRICS, SESSION_START, SESSION_END, DRIVE_SNAPSHOT, OPPORTUNITY_CREATED, DRIVE_EVENT, HEALTH_STATUS) via Zod validators. Routes inbound messages (main→child) and outbound messages (child→main) through discriminated unions keyed on DriveIPCMessageType enum. Enforces CANON §Drive Isolation by rejecting malformed or corrupted payloads at the IPC boundary with detailed Zod error context. All drive values constrained to [-10.0, 1.0]; total pressure to [0, 12.0]. Exports three public validators: validateInboundMessage (throws ZodError), validateOutboundMessage (throws ZodError), safeValidateMessage (returns {success, data|error} without throwing).

- **Exports:** `validateInboundMessage`, `validateOutboundMessage`, `safeValidateMessage`
- **Key constants:** `DriveNameSchema=z.nativeEnum(DriveName)`, `DRIVE_VALUE_RANGE=[-10.0,1.0]`, `TOTAL_PRESSURE_MAX=12.0`, `OPPORTUNITY_CLASSIFICATIONS=[PREDICTION_FAILURE_PATTERN,HIGH_IMPACT_ONE_OFF,BEHAVIORAL_NARROWING,GUARDIAN_TEACHING]`, `PRIORITY_LEVELS=[HIGH,MEDIUM,LOW]`, `FEEDBACK_SOURCES=[guardian_confirmation,guardian_correction,algorithmic]`, `THEATER_EXPRESSION_TYPES=[pressure,relief,none]`, `DRIVE_EVENT_TYPES=[DRIVE_RELIEF,DRIVE_RULE_APPLIED,OPPORTUNITY_DETECTED,SELF_EVALUATION_RUN]`
- **Deps:** `zod`, `@sylphie/shared:DriveIPCMessageType`, `@sylphie/shared:DriveName`
- **Gotchas:** passthrough() on ActionOutcomePayloadSchema allows extra fields; safeValidateMessage discards stack and returns only issue path.join+message; no runtime enforcement that outbound messages actually come from child process (only IPC type checking)

#### recovery.ts
*module* — Automatic crash recovery with exponential backoff for drive engine child process restarts.

RecoveryMechanism class implements resilient recovery for WS IPC channel crashes. Core logic: detectes unhealthy child process via HealthMonitor, initiates exponential-backoff retry with delays (1s→2s→4s→8s ceiling 60s), max 3 retries before entering safe mode alert requiring manual intervention. On each retry attempt: closes old WS connection, reconnects to wsUrl, increments reconnect counter, logs state. Supports custom backoff parameters (initialDelayMs=1000, maxDelayMs=60000, maxRetries=3, backoffMultiplier=2). Side effects: writes logs, mutates WS connection state, calls healthMonitor.getHealthReport(). Key state exposed: attemptCount, currentDelayMs, inSafeModeAlert, lastRestartAt, pendingMessageCount (stub).

- **Exports:** `RecoveryMechanism`, `RecoveryOptions`, `RecoveryState`
- **Key constants:** `initialDelayMs=1000`, `maxDelayMs=60000`, `maxRetries=3`, `backoffMultiplier=2`
- **Deps:** `@nestjs/common::Logger`, `./ws-channel.service::WsChannelService`, `./health-monitor::HealthMonitor,HealthReport`
- **Gotchas:** pendingMessageCount in RecoveryState is placeholder (0 hardcoded), actual tracking deferred to IpcChannelService; no persistent queue of in-flight messages mentioned despite file header claiming it

#### ws-channel.service.ts
*service* — WebSocket IPC channel for main app to Drive Engine communication, enforcing drive isolation per CANON §Drive Isolation.

WsChannelService is a NestJS @Injectable that manages WebSocket connectivity to a remote Drive Engine server. It replaces the old IpcChannelService fork()-based approach with a wire-protocol-only interface. Core methods: connect(url) opens WS, send(message) queues/flushes messages with disconnect safety, onMessage(type, handler) registers typed handlers, close(graceMs) gracefully shuts down with timeout fallback, isHealthy(heartbeatMs) checks open state + recent message receipt, getConnectionInfo() returns lifecycle telemetry. Implements rate-limited validation error logging (VALIDATION_ERROR_LOG_INTERVAL_MS=5000ms) to prevent event-loop flooding from malformed inbound messages. Private queue-flush loop serializes outbound traffic, tracking connectTime, lastMessageTime, and reconnectCount for observability.

- **Exports:** `WsChannelService`, `MessageHandler`
- **Key constants:** `VALIDATION_ERROR_LOG_INTERVAL_MS=5000`
- **Deps:** `@nestjs/common`, `ws`, `@sylphie/shared (DriveIPCMessage, DriveIPCMessageType, verboseFor)`, `./ipc-message-validator (safeValidateMessage)`
- **Gotchas:** Rate-limited validation error logging suppresses similar errors to avoid event-loop starvation; handler exceptions are caught+logged but don't halt dispatch; no explicit reconnection strategy in this service (delegated to RecoveryMechanism via incrementReconnectCount hook); queue behavior assumes synchronous JSON.stringify (no large binary payloads).

### `packages/drive-engine/src/postgres-verification/`

#### verify-rls.ts
*service* — Validate database RLS enforcement at startup to prevent self-modification violations

RlsVerificationService is a NestJS @Injectable service implementing OnModuleInit. On startup it verifies the sylphie_app database role cannot UPDATE or DELETE drive_rules (must fail with permission denied), but CAN SELECT from drive_rules and INSERT into proposed_drive_rules (must succeed). Each check runs in isolated connections to avoid transaction abort propagation. Three-layer isolation boundary: TypeScript design, process IPC, and RLS enforcement. Gracefully degrades if tables don't exist (pre-migration) or PostgreSQL unreachable in dev; throws CRITICAL error on actual RLS failure.

- **Exports:** `RlsVerificationService`
- **Key constants:** `POSTGRES_RUNTIME_POOL injection token`
- **Deps:** `@nestjs/common (Injectable, OnModuleInit, Logger, Inject)`, `pg (Pool)`, `@sylphie/shared (POSTGRES_RUNTIME_POOL)`
- **Gotchas:** Uses separate pool connections for each check because PostgreSQL aborts entire transaction on permission error; savepoints would not allow isolated "expected failure" tests. Silent ROLLBACK ignore in catch (line 120). Pre-migration and dev connection failures are logged as warnings but allow startup—only actual RLS enforcement failures block startup.

### `packages/drive-engine/src/rule-proposer/`

#### postgres-rules-client.ts
*service* — Type-safe PostgreSQL client for drive rule proposal and retrieval, enforcing no self-modification via RLS.

PostgresRulesClient is a NestJS injectable service wrapping a pg.Pool connection. Exports two interfaces: DriveRule (read model with id, triggerPattern, effect, enabled, confidence, createdAt, updatedAt) and ProposedRuleInput (write model for rule proposals). Two main methods: getActiveRules() queries drive_rules table filtered by enabled=true, maps rows to DriveRule objects with date parsing; insertProposedRule(rule) inserts into proposed_drive_rules with status hardcoded to 'pending', requiring guardian approval via dashboard to activate. All updates/deletes blocked by RLS at database layer. Errors logged but re-thrown; debug logging on successful proposal insert.

- **Exports:** `PostgresRulesClient`, `DriveRule`, `ProposedRuleInput`
- **Key constants:** `status='pending'`
- **Deps:** `@nestjs/common`, `pg`, `@sylphie/shared`
- **Gotchas:** No return value from insertProposedRule; only logs inserted id internally. RLS enforcement is database-side; application does not attempt updates (CANON §6 No Self-Modification).

## Risks / stubs / TODOs

- `packages/drive-engine/src/action-outcome-reporter.service.spec.ts` — Tests call driveReader.getCurrentState() but do NOT inspect sent payloads via wsChannel.sent array (created but never asserted). Dead ternary suite verifies calls happen (line 123: toHaveBeenCalledTimes(2)) but doesn't validate actual payload contents or anxiety values injected. Test coverage is behavioral/integration-level, not deep structural validation. Spec assumes ActionOutcomeReporterService constructor signature is (wsChannel, driveReader).
- `packages/drive-engine/src/action-outcome-reporter.service.ts` — Two TODOs in reportMetrics(): estimatedCostUsd hardcoded to 0 (no token-to-cost mapping), windowStartAt/windowEndAt both set to now (not tracking actual caller window boundaries). Theater check driveValue defaults to 0 if null; correspondingDrive defaults to SystemHealth if null. No validation that actionId is actually provided despite CANON Standard 2 requirement.
- `packages/drive-engine/src/constants/action-emotions.ts` — All 10 mappings use identical thresholds (0.2/0.3); registerActionEmotionMapping mutates the frozen Map at runtime via type-cast, which is a code-smell for testing/learning paths.
- `packages/drive-engine/src/constants/drives.ts` — SystemHealth is composite (derived in cross-modulation, not accumulated). Core drives (MoralValence, Integrity, CognitiveAwareness) are action-driven only. Accumulation/decay comments include calculated fill times (e.g., Curiosity ~10min from 0.3, Satisfaction relief ~18min decay). Cross-modulation uses multiplicative (suppression) and additive (amplification) effects with distinct coefficients.
- `packages/drive-engine/src/constants/events.ts` — None noted; well-documented with clear intent and no visible stubs or TODOs
- `packages/drive-engine/src/constants/opportunity-detection.ts` — None identified - straightforward constant definitions aligned with CANON §E4-T010 opportunity detection specification
- `packages/drive-engine/src/constants/prediction-evaluation.ts` — No dead code or stubs. MIN_SAMPLE_COUNT=1 is permissive (allows graduation with minimal data); comment flags this as deliberate.
- `packages/drive-engine/src/constants/rules.ts` — PRIMARY_RELIEF and SECONDARY_RELIEF are unexported private constants; RULE_CONFIDENCE_THRESHOLD at 0.3 is permissive (allows experimental rules); sensory action types require matching metadata fields (undiscoveredObjectCount, unknownPersonCount, sensoryPredictionError, sceneSurprise) or scaling fails silently
- `packages/drive-engine/src/drive-engine.tokens.ts` — DRIVE_PROCESS_MANAGER is exported from this file but NOT re-exported from index.ts barrel to enforce module boundary; consumers must not import it directly.
- `packages/drive-engine/src/drive-process/accumulation.ts` — Bounds clamped to [-10.0, 1.0] post-update; no clamping visible in this file but documented. Design assumes either accumulation OR decay per drive, not both.
- `packages/drive-engine/src/drive-process/behavioral-contingencies/contingency-coordinator.ts` — Social contingency evaluateFromOutcome() comment tracking depends on socialCommentTimestamp presence in ActionOutcomePayload; missing timestamp silently skips firing. Anxiety amplification computeDriveEffects() called with empty driveEffects map (effects computed internally elsewhere). Guilt repair passes previousErrorActionType and previousErrorContext both set to actionType (may be placeholder/stub?). curiosityInformationGain.computeReliefFromMetrics() returns 0 gracefully if informationGainMetrics absent. No error handling or validation of outcome/drive states.
- `packages/drive-engine/src/drive-process/behavioral-contingencies/curiosity-information-gain.ts` — Singleton pattern with null-initialized instance; returns negative relief values (relief = drive reduction); relies on ACTION_OUTCOME context to provide metrics (notes that WKG not yet accessible in child process); graceful degradation if metrics absent or fields missing.
- `packages/drive-engine/src/drive-process/behavioral-contingencies/guilt-repair.ts` — No external persistence — error history lost on process restart; behavioral-change detection simple string equality (could miss semantic equivalence); no validation that previousErrorActionType is actually recent (relies on caller passing correct context)
- `packages/drive-engine/src/drive-process/behavioral-contingencies/satisfaction-habituation.ts` — None visible — clean implementation matching CANON spec.
- `packages/drive-engine/src/drive-process/behavioral-contingencies/social-comment-quality.ts` — No persistent storage of comment history; buffer is ephemeral in-memory. singleton instance could be null-checked in tests. Hard-coded relief values (0.15, 0.10) are literal, not configurable.
- `packages/drive-engine/src/drive-process/clamping.ts` — Relies on clampDriveValue() from shared (implementation not in this file); DRIVE_INDEX_ORDER iteration order is load-bearing for consistent state mutation; checkBounds() excess calculation is directional (value - max or min - value) to distinguish direction of overage
- `packages/drive-engine/src/drive-process/cross-modulation.spec.ts` — Jest mock of verboseFor() suppresses test logging; test assumes rule execution order matters for cascading (Rule 1 must execute before Rule 4 to test cascading boredom suppression); no tests for clamping/saturation to [0,1] bounds after modifications; no tests for edge-case ordering where different rule orders produce different final states beyond the documented boredom->curiosity cascade
- `packages/drive-engine/src/drive-process/cross-modulation.ts` — SystemHealth rule fires based on PREVIOUS tick's composite value (deliberate one-tick lag to prevent feedback loops); clamping not applied in this module, deferred to caller; anxiety-to-curiosity suppression rule was removed (noted as semantically wrong)
- `packages/drive-engine/src/drive-process/database-clients.ts` — Both reader classes are stubs: queryCapabilities/queryDrivePatterns/queryPredictionAccuracy return empty arrays or null; IPCSelfKgReader constructor sets ready=false and never initializes IPC; multiple TODOs for Phase 2 IPC implementation and Grafeo query integration via IPC fallback; no actual Grafeo access in Phase 1, allows evaluation loop to run with zero baseline adjustment.
- `packages/drive-engine/src/drive-process/default-affect.ts` — Logic is completely delegated to computeDefaultAffect() in constants/rules.ts — this file is a thin wrapper; actual algorithm, rule defaults, and outcome bonus logic live elsewhere. No null-check on payload. No logging or monitoring of rule misses.
- `packages/drive-engine/src/drive-process/drive-baseline-adjustment.ts` — No obvious TODOs or stubs. Assumes CAPABILITY_TO_DRIVE_MAP keys are all capabilities; silently skips unknown capabilities. Stderr writes guarded by typeof process check but will log copiously on each tick if capabilities are frequently low or recovering. Comment on line 137 says 'shouldn\'t happen' for above-default adjustment but has fallback decay logic. No explicit bounds on maximum baseline above default.
- `packages/drive-engine/src/drive-process/drive-correlation-check.ts` — None detected; straightforward validation logic
- `packages/drive-engine/src/drive-process/drive-engine-import-additions.ts` — This file appears to be an instruction artifact rather than active source code—it contains only a comment directive and one import statement. Purpose is unclear; may be a fragment, template, or outdated guidance. No actual implementation logic present.
- `packages/drive-engine/src/drive-process/drive-engine.ts` — TimescaleWriter optional but recommended for state persistence across hard kills. SessionEnd handler is no-op (final snapshot published on next regular tick). eventEmitter initialized to null but never assigned after construction — appears unused. checkGraduation, checkDemotion imported but never called in tick loop. SelfEvaluator.evaluate() is fire-and-forget (non-blocking) but errors logged to console. Rule debate (proposeRuleForDebate) also fire-and-forget. Opportunity emission only occurs every 100 ticks (EMISSION_INTERVAL_TICKS), creating ~100ms batching delay. Theater prohibition verdict blocks reinforcement entirely with no partial credit. Outcome queue depth only warned at runtime, no hardening for extreme backlog. Clamping occurs on mutable reference (currentState) in-place, not defensive copy.
- `packages/drive-engine/src/drive-process/drive-process-manager.service.ts` — TODO: DRIVE_EVENT forwarding to event backbone not yet implemented (line 201); fire-and-forget opportunity writes silently swallow errors; initial health check non-blocking (warns but doesn't fail start if server down); WS reconnection entirely delegated to RecoveryMechanism
- `packages/drive-engine/src/drive-process/drive-state.ts` — Decay (negative rates) silently skips if current drive <= 0 to prevent pushing resting state below equilibrium; clampAll() writes to stderr instead of returning — blocks state below -10.0 and above 1.0 with warning. getCurrentMutable() returns live reference (used for in-place mutations by cross-modulation). No validation that effects/rates sum to zero or stay in bounds before clamping.
- `packages/drive-engine/src/drive-process/event-emitter.ts` — Queue overflow silently drops oldest event (line 220); stderr write depends on process.stderr availability. Errors in batch flush are caught and logged to stderr but do not propagate (fire-and-forget pattern may hide persistent failures). Timer-based batching uses setTimeout and setImmediate without explicit cleanup on process exit.
- `packages/drive-engine/src/drive-process/message-transport.ts` — IpcTransport has runtime checks for process.send/on presence but no error handling if send fails; fire-and-forget semantics mean no acknowledgment of delivery
- `packages/drive-engine/src/drive-process/opportunity-decay.ts` — consecutiveGoodPredictions is mutated in-place on opportunity objects; relies on external constants for thresholds; no fallback if evaluator.getMAE() returns undefined.
- `packages/drive-engine/src/drive-process/opportunity-detector.spec.ts` — No exports or runtime implementation — test-only file. jest.mock suppresses verboseFor logging. createMockEvaluator returns hardcoded MAE=0.35 for all calls, which may mask real threshold behavior if test expectations drift from actual evaluator range.
- `packages/drive-engine/src/drive-process/opportunity-detector.ts` — Line 78: failureCount computed as maeResult.sampleCount (not actual failure count but prediction window sample size); de-duplication relies on DEDUPLICATION_ENABLED flag which could be disabled; Lines 102,125,133: guardianTriggered hardcoded false with TODO comment indicating future signal extraction; registry eviction uses Map insertion-order iteration (oldest-first) which depends on JS Map semantics.
- `packages/drive-engine/src/drive-process/opportunity-priority.ts` — None observed; clean implementation
- `packages/drive-engine/src/drive-process/opportunity-queue.spec.ts` — SYLPHIE_VERBOSE env var controls logging but no action taken in test code (gated by module import); custom test runner format (not Jest/Mocha); runs via tsx directly; no mock isolation — module already imported before verboseFor patching attempt
- `packages/drive-engine/src/drive-process/opportunity-queue.ts` — No explicit documentation of MAX_QUEUE_SIZE literal value; replaceAll() is used by decay circuit (unstubbed). Priority comparison uses <= for rejection (tail.priority matched, not exceeded). vlog calls toFixed(4) on priorities—numeric formatting dependency.
- `packages/drive-engine/src/drive-process/opportunity-signal.ts` — None detected. Function returns null for LOW severity signals; caller must handle. MAE_MODERATE_THRESHOLD value not defined inline (imported from constants). Severity assignment logic has no edge-case handling (all mae >= 0.40 -> high, no upper bound check).
- `packages/drive-engine/src/drive-process/opportunity.ts` — priority field initialized to 0 and noted as computed later; no validation of input parameters; consecutiveGoodPredictions tracking mechanism exists but computation logic not shown in this file
- `packages/drive-engine/src/drive-process/planning-publisher.ts` — Hardcoded affectedDrive='cognitiveAwareness' as any (type-unsafe). sourceEventId always ''. Rate-limit mentioned in header (max 5 per 100 ticks) but not implemented in code. Classification mapping is lossy (3 input types -> 2 output types). No validation of opportunity data before sending.
- `packages/drive-engine/src/drive-process/prediction-evaluator.spec.ts` — Mocks @sylphie/shared verboseFor globally; reliance on exact MAE threshold logic for classification (ACCURATE/POOR/INSUFFICIENT_DATA not explicitly exposed in tests)
- `packages/drive-engine/src/drive-process/prediction-evaluator.ts` — predictionCount counter exists but actual predictions never read back from storage (line 59-60 comment); only getDebugInfo() uses .size; old write-only Map replaced with counter optimization; cache invalidation on window-fill (MAE_WINDOW_SIZE threshold) may mask stale data if constants imported incorrectly
- `packages/drive-engine/src/drive-process/reinforcement-blocking.ts` — Theater blocking is hard-zero (no contingency applied at all); filteredEffects remains empty in both branches; blockedEffects is populated but all passed to blockedEffects with nothing in filteredEffects, meaning theatrical actions produce no effect deltas anywhere; outcome is recorded but drive state unchanged.
- `packages/drive-engine/src/drive-process/rule-application.ts` — parseEffect returns null silently on invalid input (catch-all); multiplicative effects require base value from currentDriveState and apply post-additive; no bounds-checking or drive-state saturation logic (clipping/normalization deferred); multi-effect DSL relies on semicolon splitting with no error-reporting on parse failures
- `packages/drive-engine/src/drive-process/rule-engine.ts` — getDefaultAffect import stub (line 36-38) indicates legacy event-type-based path is no longer used but kept for compatibility. proposeRuleForDebate() is non-fatal on DB errors (won't break tick loop). reloadTimer.unref() allows process exit despite active timer. Cache is cleared on every rule reload, which may cause temporary cache misses after reload cycles.
- `packages/drive-engine/src/drive-process/rule-matching.ts` — Mixed AND/OR operators in same pattern rejected (returns null). Floating-point equality check uses hardcoded 0.0001 epsilon. Invalid drive names in conditions return null. No logging or error tracking beyond try-catch suppression. Cache key generation hard-codes four drives; other drives ignored by cache.
- `packages/drive-engine/src/drive-process/self-evaluation-circuit-breaker.ts` — No stubs or dead code; state machine assumes Date.now() consistency; process.stderr availability checked before writes; pauseStartedAt is null until circuit trips; HALF_OPEN allows one evaluation to close or reopen circuit
- `packages/drive-engine/src/drive-process/self-evaluation.ts` — selfKgReader.isReady() early-return silently skips evaluation; error during query does not trigger negative assessment record (intentional to distinguish real failures from timeouts/errors); circuit breaker can halt all self-evaluation; diagnostics exposure assumes caller understands circuit breaker state transitions
- `packages/drive-engine/src/drive-process/theater-prohibition.ts` — Post-flight verification is secondary; relies on pre-flight check from Communication module. Drive value may change between dispatch and outcome, so post-flight re-validates. No integration with actual reinforcement suppression yet (stub: verdict returned but not wired to reward signals).
- `packages/drive-engine/src/drive-process/timescale-writer.ts` — UUID generation uses Math.random() (non-cryptographic, noted as production TODO); drive_state_checkpoint table creation is idempotent but error logged on first cold start; all DB errors logged to stderr instead of thrown to avoid crashing child process; writeBatch silently discards events if pool not ready (non-blocking); loadState returns null on table-not-found (treated as cold start)
- `packages/drive-engine/src/drive-reader.service.ts` — Timestamp coercion in updateSnapshot() handles JSON deserialization (ISO string → Date); snapshot is never null but tick=0 means unhealthy (cold-start); no mutation permitted on returned defensive copies; validation error throws DriveCoherenceError with logged error context
- `packages/drive-engine/src/drive-reader/drive-state-snapshot.ts` — Timestamp serialization via JSON.stringify converts Date to ISO string; code reconstructs it post-deserialize. Staleness check skips when lastValidTimestamp is epoch sentinel (getTime() <= 0). Drive value consistency at IPC boundary is the only crash/hang detection point before cache.
- `packages/drive-engine/src/index.ts` — DRIVE_PROCESS_MANAGER and IDriveProcessManager intentionally omitted from public API to prevent coupling to infrastructure. Module boundary is enforced via explicit re-export contract.
- `packages/drive-engine/src/interfaces/drive-engine.interfaces.ts` — IDriveProcessManager explicitly NOT exported from module barrel—internal only. driveState$ Observable may be 1-2 ticks stale due to IPC latency (acceptable, drives change slowly relative to 100Hz tick). reportOutcome and reportMetrics are fire-and-forget (void); no acknowledgment waits. Drive rule proposals never autonomously approved—guardian tooling copies to active table only.
- `packages/drive-engine/src/interfaces/drive-events.ts` — None identified; clean type definitions with no stubs or TODOs. Sampled emission strategy for DriveTickEvent to avoid flooding TimescaleDB is documented but implemented elsewhere.
- `packages/drive-engine/src/interfaces/self-kg.interfaces.ts` — ISelfKgReader is explicitly read-only; Drive Engine must never write to KG(Self). ISelfKgReader.queryCapabilities() and queryDrivePatterns() return empty arrays if unavailable rather than null. Implementation is a Grafeo adapter in Drive Engine process. No explicit error handling documented for failed queries.
- `packages/drive-engine/src/ipc-channel/health-monitor.ts` — childMemoryBytes hardcoded to null (line 123), never populated; comment says memory monitoring is planned but not implemented. IPC handler design constraint documented (line 88-90) prevents registering own onMessage for DRIVE_SNAPSHOT—relies on external recordSnapshot() call from DriveProcessManagerService, creating coupling risk if caller forgets to wire it.
- `packages/drive-engine/src/ipc-channel/ipc-channel.service.ts` — Uses __dirname relative path (ipc-channel.service.ts → ../drive-process/main) which may be fragile if file structure changes; __filename.ts/.js detection for dev vs compiled mode (relies on execution context); sendQueue messages persist if child crashes — Recovery Mechanism responsible for re-queue on restart; no timeout on message handler execution (could block processSendQueue).
- `packages/drive-engine/src/ipc-channel/ipc-message-validator.ts` — passthrough() on ActionOutcomePayloadSchema allows extra fields; safeValidateMessage discards stack and returns only issue path.join+message; no runtime enforcement that outbound messages actually come from child process (only IPC type checking)
- `packages/drive-engine/src/ipc-channel/recovery.ts` — pendingMessageCount in RecoveryState is placeholder (0 hardcoded), actual tracking deferred to IpcChannelService; no persistent queue of in-flight messages mentioned despite file header claiming it
- `packages/drive-engine/src/ipc-channel/ws-channel.service.ts` — Rate-limited validation error logging suppresses similar errors to avoid event-loop starvation; handler exceptions are caught+logged but don't halt dispatch; no explicit reconnection strategy in this service (delegated to RecoveryMechanism via incrementReconnectCount hook); queue behavior assumes synchronous JSON.stringify (no large binary payloads).
- `packages/drive-engine/src/postgres-verification/verify-rls.ts` — Uses separate pool connections for each check because PostgreSQL aborts entire transaction on permission error; savepoints would not allow isolated "expected failure" tests. Silent ROLLBACK ignore in catch (line 120). Pre-migration and dev connection failures are logged as warnings but allow startup—only actual RLS enforcement failures block startup.
- `packages/drive-engine/src/rule-proposer.service.ts` — Hard-coded confidence 0.5 for all proposals regardless of quality; effect serialization as JSON string may limit querying; no external event emission here (caller responsibility); error logging but no retry logic; rationale field labeled 'reasoning' in DB call
- `packages/drive-engine/src/rule-proposer/postgres-rules-client.ts` — No return value from insertProposedRule; only logs inserted id internally. RLS enforcement is database-side; application does not attempt updates (CANON §6 No Self-Modification).

## Change log
- 2026-06-13 — Initial auto-generated map (69 files read in full).
