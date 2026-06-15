# shared — Architecture Reference

> Living document. Last updated: 2026-06-13. Auto-generated from full-file reads (one agent per file); verify before trusting any single line.

**32 files** mapped.

## File-by-file

### `packages/shared/src/`

#### index.ts
*barrel* — Centralized re-export barrel for shared infrastructure (config, storage services, types, exceptions, logging)

This barrel module aggregates exports from database configuration (Neo4j, TimescaleDB, PostgreSQL), Prisma ORM service/module, TimescaleDB service/module, Neo4j service/module with instance configuration, raw PostgreSQL connection pools for drive engine RLS, all type definitions via wildcard from ./types, all exceptions via wildcard from ./exceptions, and verbose logging utilities (verbose, verboseFor, isVerbose, reconfigureVerbose). No logic or implementations here — purely a namespace aggregator for coordinating infrastructure access across the monorepo. Serves as the single import point for dependent packages.

- **Exports:** `neo4jConfig`, `timescaleConfig`, `postgresConfig`, `ollamaConfig`, `voiceConfig`, `PrismaService`, `PrismaModule`, `TimescaleService`, `TimescaleModule`, `Neo4jService`, `Neo4jModule`, `Neo4jInstanceName`, `NEO4J_INSTANCE_CONFIG`, `Neo4jInstanceConfig`, `Neo4jModuleConfig`, `POSTGRES_ADMIN_POOL`, `POSTGRES_RUNTIME_POOL`, `*from ./types`, `*from ./exceptions`, `verbose`, `verboseFor`, `isVerbose`, `reconfigureVerbose`
- **Deps:** `./config/database.config`, `./config/ollama.config`, `./config/voice.config`, `./storage/prisma.service`, `./storage/prisma.module`, `./storage/timescale.service`, `./storage/timescale.module`, `./storage/neo4j.service`, `./storage/neo4j.module`, `./storage/neo4j.constants`, `./storage/database.tokens`, `./types`, `./exceptions`, `./verbose`
- **Gotchas:** Wildcard exports from ./types and ./exceptions mask specific exported symbols; consumers cannot easily discover what is available without reading those modules

#### verbose.ts
*util* — Lightweight verbose logging utility for tracing system behavior, decision-making, and performance across subsystems.

Provides three core exports: verbose(subsystem, message, data?) for direct logging, verboseFor(subsystem) for creating scoped loggers to avoid repeating subsystem names, and isVerbose(subsystem?) to check if logging is active (useful for guarding expensive serialization). Logging is controlled by VERBOSE env var: '1'/'true'/'*' enables all subsystems, comma-separated names enable only those subsystems, empty/unset/false disables logging. Output goes to stderr (never contaminating stdout) and optionally to logs/verbose.log via a persistent WriteStream. Timestamp format is ISO string, each line includes [subsystem] tag. Configuration runs on import via configure() and can be re-run at runtime via reconfigureVerbose().

- **Exports:** `verbose`, `verboseFor`, `isVerbose`, `reconfigureVerbose`
- **Key constants:** `VERBOSE env format: '1'\|'true'\|'*' for all, comma-separated names for selected, empty for disabled`, `log file location: logs/verbose.log (relative to process.cwd())`, `timestamp format: ISO 8601`
- **Deps:** `fs`, `path`
- **Gotchas:** logStream silently set to null if file write fails; verbose logging continues to stderr regardless. configure() runs once on import; users must call reconfigureVerbose() if env changes post-import or after dotenv loads late.

### `packages/shared/src/config/`

#### database.config.ts
*config* — NestJS config factory exporting Neo4j, TimescaleDB, and PostgreSQL connection profiles for multi-database orchestration.

Exports three NestJS config factories (neo4jConfig, timescaleConfig, postgresConfig) via registerAs(). neo4jConfig defines four graph DB endpoints: world (RLS-isolated, 3 required env vars), self (local instance, 3 required env vars), other (external/federated, 3 required env vars), and pkg (PKG graph with defaults: bolt://localhost:7691, user neo4j, password sylphie-pkg-local). timescaleConfig sets up TimescaleDB for time-series events (host localhost:5433, db sylphie_events, 90-day retention, 7-day compression). postgresConfig sets up PostgreSQL system DB (localhost:5434, db sylphie_system) with separate admin and runtime user credentials. All three support environment variable overrides with sensible defaults (pool size 10-50, timeouts 5000ms, idle 30s). No side effects; purely declarative config objects.

- **Exports:** `neo4jConfig`, `timescaleConfig`, `postgresConfig`
- **Key constants:** `NEO4J_PKG_URI=bolt://localhost:7691`, `NEO4J_PKG_USER=neo4j`, `NEO4J_PKG_PASSWORD=sylphie-pkg-local`, `NEO4J_*_DATABASE=neo4j (default)`, `TIMESCALE_HOST=localhost`, `TIMESCALE_PORT=5433`, `TIMESCALE_DB=sylphie_events`, `TIMESCALE_RETENTION_DAYS=90`, `TIMESCALE_COMPRESSION_DAYS=7`, `POSTGRES_HOST=localhost`, `POSTGRES_PORT=5434`, `POSTGRES_DB=sylphie_system`, `Pool sizes: neo4j-world/self/other=50, neo4j-pkg=10, timescale=20, postgres=10`, `Timeouts: connectionTimeoutMs=5000, idleTimeoutMs=30000`
- **Deps:** `@nestjs/config`
- **Gotchas:** world/self/other neo4j endpoints have required env vars (non-falsy) but no fallback defaults; deployment must provide them or app will crash. pkg endpoint has full defaults for local dev. No validation of URI format or connectivity at config time.

#### ollama.config.ts
*config* — NestJS configuration factory for Ollama LLM backend and tiered model routing.

Exports ollamaConfig—a NestJS registerAs factory that configures Ollama host, three-tier model selection (quick/medium/deep), embedding model, chat timeout, SearXNG URL, and optional DeepSeek API integration. Quick tier (3B) runs locally for fast phrases/facts; medium tier (7B local or DeepSeek API) for balanced tasks; deep tier (20B local or DeepSeek) for complex reasoning/debate. When DEEPSEEK_API_KEY is set, medium and deep route to DeepSeek API instead of local Ollama. Embedding always uses nomic-embed-text. Default Ollama host is localhost:11434; SearXNG at localhost:8888.

- **Exports:** `ollamaConfig`
- **Key constants:** `OLLAMA_HOST=http://localhost:11434`, `OLLAMA_EMBED_MODEL=nomic-embed-text`, `OLLAMA_MODEL_QUICK=qwen2.5:3b`, `OLLAMA_MODEL_MEDIUM=qwen2.5:7b`, `OLLAMA_MODEL_DEEP=gpt-oss:20b`, `OLLAMA_CHAT_TIMEOUT_MS=30000`, `SEARXNG_URL=http://localhost:8888`, `DEEPSEEK_BASE_URL=https://api.deepseek.com`, `DEEPSEEK_MODEL=deepseek-reasoner`
- **Deps:** `@nestjs/config`
- **Gotchas:** No validation of env vars; parseable integers assumed for chatTimeoutMs; DEEPSEEK_API_KEY empty string means disabled (falsy check will pass); fallback chain on OLLAMA_CHAT_MODEL suggests legacy naming still supported; no error handling if env-configured models are unavailable at runtime.

#### voice.config.ts
*config* — Voice service configuration factory for Deepgram speech-to-text and Elevenlabs text-to-speech integrations

Exports a single NestJS config factory `voiceConfig` that provides environment-driven configuration for two voice vendors. Deepgram API key, Elevenlabs API key, Elevenlabs voice ID (defaults to '21m00Tcm4TlvDq8ikWAM'), and Elevenlabs model ID (defaults to 'eleven_turbo_v2_5') are all read from environment variables with sensible defaults where provided. No runtime logic; pure configuration structure used by dependency injection.

- **Exports:** `voiceConfig`
- **Key constants:** `ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM`, `ELEVENLABS_MODEL_ID=eleven_turbo_v2_5`
- **Deps:** `@nestjs/config`
- **Gotchas:** Deepgram API key has no default and falls back to empty string if unset; Elevenlabs API key similarly has no default; dependent services must validate these are set before use.

### `packages/shared/src/exceptions/`

#### domain.exceptions.ts
*module* — Domain exception base classes for CANON subsystems

Exports six exception classes (KnowledgeException, DriveException, CommunicationException, LearningException, PlanningException, DecisionMakingException), each pinning its subsystem field to the CANON-canonical name for routing and log aggregation. Each constructor accepts message, optional code (defaults to 'UNKNOWN'), optional context object, and optional cause. All extend SylphieException and call super() with their subsystem name. Knowledge covers WKG/Grafeo/Neo4j errors and integrity violations. Drive covers IPC and process isolation. Communication covers input parsing, LLM calls, TTS, and person modeling. Learning covers consolidation cycles and entity extraction. Planning covers opportunity intake, simulation, and constraint validation. Decision-making covers arbitration, memory, prediction, and executor state machine.

- **Exports:** `KnowledgeException`, `DriveException`, `CommunicationException`, `LearningException`, `PlanningException`, `DecisionMakingException`
- **Deps:** `./sylphie.exception`
- **Gotchas:** All six classes follow identical constructor signature pattern; code defaults to 'UNKNOWN' per convention; subsystem names are hardcoded per class (knowledge, drive-engine, communication, learning, planning, decision-making)

#### index.ts
*barrel* — Centralized exception export barrel for all domain, infrastructure, and system-level errors across Sylphie subsystems.

This barrel exports the base SylphieException class and six domain-specific exception hierarchies (KnowledgeException, DriveException, CommunicationException, LearningException, PlanningException, DecisionMakingException) plus eight specific exception classes (ProvenanceMissingError, ConfidenceCeilingViolation, ContradictionDetectedError, DriveUnavailableError, DriveCoherenceError, TestEnvironmentError, LesionModeError, MetricsComputationError). Each exception carries subsystem (e.g., 'knowledge', 'drive-engine'), code (machine-readable error identifier), context (diagnostic key-value pairs for reproduction), and optional cause (wrapped underlying error). SylphieException enforces structured error metadata per CANON principles (provenance, confidence ceiling, drive isolation). No side effects; purely declarative exports.

- **Exports:** `SylphieException`, `KnowledgeException`, `DriveException`, `CommunicationException`, `LearningException`, `PlanningException`, `DecisionMakingException`, `ProvenanceMissingError`, `ConfidenceCeilingViolation`, `ContradictionDetectedError`, `DriveUnavailableError`, `DriveCoherenceError`, `TestEnvironmentError`, `LesionModeError`, `MetricsComputationError`
- **Gotchas:** None. Pure barrel with import/export only.

#### specific.exceptions.ts
*module* — Defines CANON-constrained exception classes for well-defined error conditions with stable error codes.

Exports six exception classes for knowledge integrity (ProvenanceMissingError, ConfidenceCeilingViolation, ContradictionDetectedError), drive engine isolation (DriveUnavailableError, DriveCoherenceError), and testing harness concerns (TestEnvironmentError, LesionModeError), plus metrics computation errors (MetricsComputationError). ProvenanceMissingError enforces CANON §7 (provenance required on all WKG writes, code: PROVENANCE_MISSING). ConfidenceCeilingViolation enforces CANON Immutable Standard 3 (confidence capped at 0.60 until retrieval-and-use event, code: CONFIDENCE_CEILING_VIOLATION). ContradictionDetectedError surfaces Piagetian disequilibrium when upsert detects conflicts (code: CONTRADICTION_DETECTED). DriveUnavailableError thrown when Drive Engine process is unreachable via IPC (code: DRIVE_UNAVAILABLE). DriveCoherenceError thrown when incoming snapshot fails validation checks: drive values in [-10.0, 1.0], not all drives zero, timestamp fresh (<1s), totalPressure consistent with pressureVector (code: DRIVE_COHERENCE_ERROR). TestEnvironmentError and LesionModeError support lesion test bootstrap and lesion mode enable/disable with flexible codes. MetricsComputationError raised when seven primary health metrics cannot be computed/aggregated (code varies). All exceptions carry context Record and optional cause parameter for error chaining.

- **Exports:** `ProvenanceMissingError`, `ConfidenceCeilingViolation`, `ContradictionDetectedError`, `DriveUnavailableError`, `DriveCoherenceError`, `TestEnvironmentError`, `LesionModeError`, `MetricsComputationError`
- **Key constants:** `PROVENANCE_MISSING`, `CONFIDENCE_CEILING_VIOLATION (ceiling default 0.60)`, `CONTRADICTION_DETECTED`, `DRIVE_UNAVAILABLE`, `DRIVE_COHERENCE_ERROR (drive range [-10.0, 1.0], staleness threshold 1s)`, `BOOTSTRAP_FAILED`, `LESION_ENABLE_FAILED`, `LESION_DISABLE_FAILED`
- **Deps:** `./domain.exceptions (KnowledgeException, DriveException)`, `./sylphie.exception (SylphieException)`
- **Gotchas:** ContradictionDetectedError used only in code paths that cannot return discriminated union; normal WKG reads return union instead. All exceptions default code='UNKNOWN' when not explicitly provided. DriveCoherenceError validation thresholds hardcoded in docstring but checked in DriveReaderService (not this file). No side effects in exception constructors themselves.

#### sylphie.exception.ts
*util* — Base exception class for all domain errors with structured diagnostic context

SylphieException is the root Error class extended by all application exceptions. It enforces three required fields: subsystem (coarse module origin, aligned to CANON subsystem names), code (machine-readable string unique within subsystem for programmatic handling like retry/circuit-break logic), and context (arbitrary Record<string, unknown> for diagnostic key-value pairs including nodeIds, session IDs, etc.). The Error.cause property is manually attached to preserve lower-level stack traces when wrapping database driver or network errors. Constructor takes message, subsystem, code, context, and optional cause; sets this.name to constructor.name and resets the Error prototype.

- **Exports:** `SylphieException`
- **Gotchas:** Error.cause is manually attached via type assertion because ES2022 Error.cause is not in ES2021 lib typings, though it is supported at runtime in Node 16+. All domain exceptions must extend this base class to maintain consistent error structure.

### `packages/shared/src/storage/`

#### database.tokens.ts
*config* — Injection tokens for PostgreSQL connection pool providers

Exports two Symbol-based DI tokens for PostgreSQL pool management: POSTGRES_ADMIN_POOL (admin credentials, DDL/DML, used only by initialization services for schema setup) and POSTGRES_RUNTIME_POOL (runtime user credentials, SELECT via RLS, injected into services needing read-only access). Enforces CANON §Drive Isolation: two-pool architecture prevents application from modifying drive rules. No classes, functions, or runtime code; pure token definitions for dependency injection.

- **Exports:** `POSTGRES_ADMIN_POOL`, `POSTGRES_RUNTIME_POOL`
- **Key constants:** `POSTGRES_ADMIN_POOL=Symbol(POSTGRES_ADMIN_POOL)`, `POSTGRES_RUNTIME_POOL=Symbol(POSTGRES_RUNTIME_POOL)`

#### neo4j.constants.ts
*config* — Neo4j configuration constants and type definitions for multi-instance database support

Defines a single configuration token constant NEO4J_INSTANCE_CONFIG used for dependency injection. Exports Neo4jInstanceName enum with four instance types: WORLD (global knowledge graph), SELF (internal state/memories), OTHER (external actors), and PKG (package/code dependency graph). Neo4jInstanceConfig interface specifies per-instance connection parameters: name, URI, user/password credentials, database name, connection pool size, and timeout in milliseconds. Neo4jModuleConfig aggregates an array of Neo4jInstanceConfig for multi-instance initialization.

- **Exports:** `NEO4J_INSTANCE_CONFIG`, `Neo4jInstanceName`, `Neo4jInstanceConfig`, `Neo4jModuleConfig`
- **Key constants:** `NEO4J_INSTANCE_CONFIG="NEO4J_INSTANCE_CONFIG"`

#### neo4j.module.ts
*module* — NestJS dynamic module factory for Neo4j graph database service injection

Neo4jModule is a global NestJS module that provides dependency injection for Neo4jService and Neo4jModuleConfig. It exports two factory methods: forRoot() accepts synchronous Neo4jModuleConfig and registers providers immediately; forRootAsync() accepts a factory function returning Promise<Neo4jModuleConfig> for async initialization (e.g., loading from environment or external config sources). Both register NEO4J_INSTANCE_CONFIG token and Neo4jService globally, making them available via constructor injection throughout the application. The module uses NestJS @Global() and @Module() decorators to enable singleton access.

- **Exports:** `Neo4jModule`
- **Key constants:** `NEO4J_INSTANCE_CONFIG`
- **Deps:** `@nestjs/common`, `./neo4j.constants`, `./neo4j.service`
- **Gotchas:** No error handling in forRootAsync() factory invocation; useFactory signature accepts variadic args but relies on injected dependencies being resolvable; no validation of Neo4jModuleConfig shape at module registration time.

#### neo4j.service.ts
*service* — NestJS injectable service that manages multiple Neo4j driver instances and provides session factory

Exports Neo4jService, a NestJS @Injectable that initializes and manages a Map of neo4j-driver instances keyed by instance name. Constructor iterates config.instances and creates drivers with configured URI, basic auth (user/password), maxConnectionPoolSize, and connectionTimeoutMs. onModuleInit connects each driver with exponential retry (5 attempts, 3000ms delay). getDriver(name) retrieves a driver by name or throws if unconfigured. getSession(name, mode='WRITE') creates a driver.session with database routing and defaultAccessMode (READ or WRITE). onModuleDestroy closes all drivers on module teardown. Lazy reconnection attempted if initial connection fails.

- **Exports:** `Neo4jService`
- **Key constants:** `retries=5`, `delayMs=3000`, `defaultAccessMode=WRITE`, `defaultDatabase='neo4j'`
- **Deps:** `@nestjs/common (Injectable, Inject, OnModuleInit, OnModuleDestroy, Logger)`, `neo4j-driver (driver, Driver, Session)`, `./neo4j.constants (NEO4J_INSTANCE_CONFIG, Neo4jModuleConfig, Neo4jInstanceName)`
- **Gotchas:** Lazy reconnection on init failure: drivers.get() returns undefined if instance not found, throwing at getDriver time (no preemptive validation). No explicit error recovery in getSession if instance config lookup returns undefined—falls back to 'neo4j' database name silently. No connection pooling metrics or health checks exposed.

#### prisma.module.ts
*module* — NestJS global module exporting the PrismaService for database access

Defines a NestJS @Global() @Module() that provides and exports PrismaService. This is a minimal barrel that makes PrismaService available application-wide without explicit imports in consuming modules. The PrismaService is imported from ./prisma.service and registered as a provider. Global scope ensures all modules can access the database instance without re-declaring the dependency.

- **Exports:** `PrismaModule`
- **Deps:** `@nestjs/common (Global, Module decorators)`, `./prisma.service (PrismaService)`

#### prisma.service.ts
*service* — NestJS singleton for PostgreSQL database client lifecycle management

PrismaService extends PrismaClient and implements NestJS OnModuleInit/OnModuleDestroy lifecycle hooks. Constructor reads postgres config (runtimeUser, runtimePassword, host, port, database) and initializes PrismaClient with a postgres:// connection URL. onModuleInit() attempts to connect to PostgreSQL with retry logic: max 5 attempts with 3-second backoff between failures (hard fail after 5 attempts logs error and returns gracefully). onModuleDestroy() calls $disconnect() on shutdown. Logging is always [warn, error] regardless of APP_ENV. Lazy evaluation of connection — queries fail if module init never connected.

- **Exports:** `PrismaService`
- **Key constants:** `maxAttempts=5`, `retryDelayMs=3000`
- **Deps:** `@nestjs/common`, `@nestjs/config`, `@prisma/client`
- **Gotchas:** No-op return on final connection failure (line 38) allows module to proceed with stale/disconnected client; subsequent queries will fail silently at query time rather than during init. onModuleDestroy disconnect is not awaited in NestJS lifecycle so slow disconnects may not complete. Log config ignores APP_ENV value and always uses [warn, error] (line 19-21 has dead branch).

#### timescale.module.ts
*module* — NestJS module that exports TimescaleService globally

Minimal NestJS @Global() @Module decorator that registers TimescaleService as a provider and exports it. The module makes TimescaleService available throughout the application without explicit imports in consuming modules. TimescaleService is the concrete implementation for TimescaleDB interactions (actual logic in timescale.service.ts). No constants, side-effects, or control flow beyond dependency registration.

- **Exports:** `TimescaleModule`
- **Deps:** `@nestjs/common`, `./timescale.service`
- **Gotchas:** This is a pure module barrel — all actual logic/contracts live in timescale.service.ts; module itself is structural only

#### timescale.service.ts
*service* — NestJS Injectable providing pooled PostgreSQL/TimescaleDB connection management and query execution

Exports TimescaleService, a NestJS lifecycle-aware service that wraps a pg Pool for TimescaleDB. Constructor reads timescale config (host, port, database, user, password, maxConnections, idleTimeoutMs, connectionTimeoutMs) and initializes Pool. onModuleInit() retries connection 5 times with 3s delays (lines 30-54), logging attempts and failure warnings. onModuleDestroy() closes pool and logs disconnect. Provides three public methods: query<T>() delegates to pool.query(); getClient() returns a raw PoolClient; withTransaction<T>() acquires client, runs BEGIN, executes callback, commits or rolls back on error (lines 73-88). Pool is typed for pg@^8 QueryResult/QueryResultRow. Logs via NestJS Logger.

- **Exports:** `TimescaleService`
- **Key constants:** `5 (connection retry attempts)`, `3000 (retry delay milliseconds)`
- **Deps:** `@nestjs/common (Injectable, OnModuleInit, OnModuleDestroy, Logger)`, `@nestjs/config (ConfigService)`, `pg (Pool, PoolClient, QueryResult, QueryResultRow)`
- **Gotchas:** onModuleInit() swallows fatal connection errors after 5 attempts (line 41-48) — logs error but returns normally, leaving pool in failed state; subsequent queries will fail. No explicit retry logic in query() itself, only at init. Config injection assumes 'timescale' key exists in ConfigService.

### `packages/shared/src/types/`

#### action.types.ts
*type* — Core action system type definitions for the Decision Making subsystem (CANON Subsystem 1).

Defines the complete action pipeline: ActionProcedureData (durable procedure nodes from WKG with ACT-R confidence snapshot at retrieval, triggerContext fingerprint, provenance source, and ordered ActionStep sequences); ActionCandidate (procedure paired with confidence, motivating drive, contextMatchScore [0.0-1.0], and driveRelevanceScore for Ashby Loop 4 analysis); ArbitrationResult discriminated union with three exhaustive variants (TYPE_1: high-confidence graph-based selection, TYPE_2: LLM deliberation with llmRationale for theater validation, SHRUG: threshold failure signal per Standard 4 Shrug Imperative); SelectedAction (committed execution form with actionId provenance, theaterValidated flag per Standard 1 Theater Prohibition, arbitrationResult reference); ExecutorState enum (8 states: IDLE, CATEGORIZING, PREDICTING, ARBITRATING, RETRIEVING, EXECUTING, OBSERVING, LEARNING); ActionOutcome (observed result with predictionAccurate, predictionError, driveEffectsObserved map, anxietyAtExecution for §A.15 Anxiety Amplification, observedAt timestamp). Confidence threshold defaults to 0.50 for WKG retrieval. Context matching uses cosine similarity > 0.7 (§A.15). Anxiety amplification applies 1.5x confidence reduction when anxietyAtExecution > 0.7 with negative outcome.

- **Exports:** `DriveCategory`, `ActionProcedureData`, `ActionStep`, `ActionCandidate`, `ArbitrationResult`, `SelectedAction`, `ExecutorState`, `ActionOutcome`
- **Key constants:** `confidence_retrieval_threshold=0.50`, `cosine_similarity_guilt_repair_threshold=0.7`, `anxiety_amplification_threshold=0.7`, `anxiety_amplification_multiplier=1.5x`
- **Deps:** `drive.types`, `provenance.types`, `decision-making.types`
- **Gotchas:** ActionProcedureData.confidence is a snapshot at retrieval time and does not update post-retrieval (must use IConfidenceService.recordUse for updates). ActionCandidate.driveRelevanceScore is optional with 0.0 default for candidates constructed outside the retriever. ArbitrationResult SHRUG variant must include shrugDetail for downstream systems (Communication, Planning) to act on specific incomprehension types. Theater validation failure results in zero reinforcement regardless of guardian response.

#### communication.types.ts
*type* — Communication subsystem types: input parsing, response delivery (TTS + chatbox), person modeling, and event logging data structures.

Defines four key types: KnowledgeGrounding (GROUNDED | LLM_ASSISTED | UNKNOWN) classifies how well a response is backed by Sylphie's WKG vs. LLM training. TurnOriginator (userId, socketId, isGuardian) identifies the speaker triggering a cycle, enforcing CANON provenance-required standard. CycleResponse is the Decision Making → Communication handoff containing response text, arbitration path (TYPE_1/TYPE_2/SHRUG), drive snapshots, latency, LLM tokens, knowledge grounding labels with provenance references, and optional tensor cognition metadata (tensorTopCategory, tensorUrgency, tensorConsensus, bootstrapMode). InputParseResult captures parsed input (type, content, entities, guardianFeedbackType, sessionId). DeliveryPayload is the Communication → Gateway handoff containing text, audio (base64), turn/originator IDs, isGrounded flag, arbitration type, latency, llmCalled, costUsd, and grounding metadata. Enforces Theater Prohibition validation on delivery. All types use readonly fields to prevent accidental mutation.

- **Exports:** `KnowledgeGrounding`, `TurnOriginator`, `CycleResponse`, `InputParseResult`, `DeliveryPayload`
- **Key constants:** `inputType: GREETING\|QUESTION\|STATEMENT\|COMMAND\|EMOTIONAL_EXPRESSION\|GUARDIAN_FEEDBACK\|UNKNOWN`, `arbitrationType: TYPE_1\|TYPE_2\|SHRUG`, `guardianFeedbackType: confirmation\|correction\|none`, `knowledgeGrounding: GROUNDED\|LLM_ASSISTED\|UNKNOWN`, `groundedBy: OKG\|WKG`
- **Deps:** `./drive.types (DriveSnapshot, PressureVector)`, `./action.types (ArbitrationResult)`
- **Gotchas:** WS4 Ticket 3: originator field is optional (undefined for self-initiated drive-pressure cycles, autonomous research). Theater Prohibition validation happens in Communication before delivery. groundingProvenance is OKG format attr-${personId}-${factKey} or WKG node_id; null when LLM_ASSISTED or UNKNOWN. Text field is empty string for SHRUG results, Communication decides how to express incomprehension. latentPatternIds populated only when new latent patterns written during cycle. Tensor metadata optional, only present if sidecar available. preExecutionDriveSnapshot needed for accurate driveEffectsObserved delta computation (WS3). No stubs present; fully wired per project conventions.

#### confidence.types.ts
*type* — Pure computational layer for ACT-R confidence dynamics with CANON immutable standards enforcement.

Defines ACTRParams interface (base, count, decayRate, lastRetrievalAt) for storing per-node/edge confidence state. Exports computeConfidence() pure function implementing ACT-R formula: min(1.0, base + 0.12*ln(count) - d*ln(hours+1)), with ceiling enforcement (0.60 max for untested knowledge per Standard 3). applyGuardianWeight() applies 2x/3x multipliers for confirmation/correction per Standard 5. Two decision functions: qualifiesForGraduation() checks confidence>0.80 AND MAE<0.10 for Type 2→1 promotion; qualifiesForDemotion() triggers on MAE>0.15. CONFIDENCE_THRESHOLDS constant defines retrieval(0.50), ceiling(0.60), graduation(0.80), demotionMAE(0.15), graduationMAE(0.10). DEFAULT_DECAY_RATES maps CoreProvenanceSource to decay rates: GUARDIAN(0.03 slowest), SENSOR(0.05), INFERENCE(0.06), LLM_GENERATED(0.08 fastest). All code is write-protected per Standard 6 (no self-modification of evaluation).

- **Exports:** `ACTRParams`, `CONFIDENCE_THRESHOLDS`, `DEFAULT_DECAY_RATES`, `computeConfidence`, `applyGuardianWeight`, `qualifiesForGraduation`, `qualifiesForDemotion`
- **Key constants:** `retrieval=0.50`, `ceiling=0.60`, `graduation=0.80`, `demotionMAE=0.15`, `graduationMAE=0.10`, `SENSOR=0.05`, `GUARDIAN=0.03`, `LLM_GENERATED=0.08`, `INFERENCE=0.06`, `ACT-R growth rate=0.12`, `formula multiplier for decay calculation in hours`
- **Deps:** `./provenance.types#CoreProvenanceSource`
- **Gotchas:** No side effects or I/O; pure functions only. Confidence Ceiling (Standard 3) enforces max 0.60 for count===0. Guardian Asymmetry (Standard 5) multipliers are structural and cannot be reduced by learning. Decay calculations assume hours-based time; lastRetrievalAt null implies count===0. No stubs or TODOs present; code is canonical and complete.

#### decision-making.types.ts
*type* — Decision-making subsystem type definitions for episodic memory, predictions, cognitive context, and arbitration.

Defines the central cognitive loop's 8-state FSM data structures: EpisodeSource (conversation|perception|legacy), VisualContext with per-field provenance, Episode and EpisodeInput for episodic encoding, Prediction and PredictionEvaluation for PREDICT-ACT-EVALUATE cycle, GapType and ShrugDetail for named incomprehension classification, ContradictionScanResult for pre-commit coherence checking, ThresholdResult for dynamic confidence modulation by drive state (clamped [0.30, 0.70]), CognitiveContext as the assembled working memory for LLM prompts, ConsolidationCandidate/SemanticRelationship/SemanticConversion for learning-phase WKG consolidation, and GraduationRecord tracking Type 1 vs Type 2 procedure transitions via rolling MAE over last 10 uses.

- **Exports:** `EpisodeSource`, `VisualContext`, `EncodingDepth`, `EpisodeInput`, `Episode`, `Prediction`, `PredictionEvaluation`, `GapType`, `ShrugDetail`, `ContradictionScanResult`, `ContradictionEntry`, `ThresholdResult`, `CognitiveContext`, `ConsolidationCandidate`, `SemanticRelationship`, `SemanticConversion`, `ConsolidationResult`, `GraduationState`, `GraduationRecord`
- **Key constants:** `ageWeight=attention*exp(-0.1*hoursSinceEncoding)`, `ENCODING_GATE=attention>0.60 OR arousal>0.60`, `THRESHOLD_RANGE=[0.30,0.70]`, `GRADUATION_MAE_THRESHOLD=0.50`, `MAE_HISTORY_WINDOW=10`, `CONFIDENCE_THRESHOLDS.retrieval=0.50`, `EPISODE_RING_BUFFER_SIZE=50`
- **Deps:** `./drive.types`, `./action.types`, `./provenance.types`
- **Gotchas:** EpisodeSource 'legacy' is deserialization-only sentinel (never stamped on fresh writes) to ensure per-episode provenance derivation is falsifiable; VisualContext sub-fields carry DIFFERENT provenance tiers (caption=LLM_GENERATED, sceneLabels=SENSOR, personIds=INFERENCE) and must never be collapsed to single episode-level tag; speakerId and speakerIsGuardian required for guardian-asymmetry ×2/×3 scoring and ×2/×3 prediction accuracy weighting; ContradictionScanResult currently defined but contradiction-scan pre-commit logic may be incomplete; graduatedAt/demotedAt timestamps allow null for never-transitioned procedures.

#### drive.types.ts
*type* — Canonical type definitions for the 12-drive motivational architecture (4 core + 8 complement); range [-10.0, 1.0].

Defines DriveName enum (SystemHealth, MoralValence, Integrity, CognitiveAwareness, Guilt, Curiosity, Boredom, Anxiety, Satisfaction, Sadness, Focus, Social) and supporting types: PressureVector (all 12 drive values as readonly), PressureDelta (per-tick changes), DriveSnapshot (enriched state with pressureVector, timestamp, tickNumber, driveDeltas, ruleMatchResult, totalPressure, sessionId). Exports DRIVE_RANGE constants (min=-10.0, max=1.0), DRIVE_INDEX_ORDER array, CORE_DRIVES/COMPLEMENT_DRIVES categorization, INITIAL_DRIVE_STATE (all zeros per CANON §A.14), and utility functions clampDriveValue() and computeTotalPressure(). Positive values [0, 1.0] represent unmet pressure; negative [-10.0, 0) represent extended relief buffering. RuleMatchResult captures Postgres rule match outcome (ruleId, eventType, matched flag). Zero-dependency foundation file; read-only value objects enforce immutability across subsystem boundaries.

- **Exports:** `DriveName`, `DRIVE_INDEX_ORDER`, `DRIVE_RANGE`, `clampDriveValue`, `PressureVector`, `PressureDelta`, `RuleMatchResult`, `DriveSnapshot`, `INITIAL_DRIVE_STATE`, `CORE_DRIVES`, `COMPLEMENT_DRIVES`, `computeTotalPressure`
- **Key constants:** `DRIVE_RANGE.min=-10.0`, `DRIVE_RANGE.max=1.0`, `INITIAL_DRIVE_STATE (all 12 drives = 0.0)`, `totalPressure max=12.0`
- **Gotchas:** INITIAL_DRIVE_STATE is all zeros (not the WS3 cold-start setup referenced in comments); comment mentions Curiosity=0.3 and Social=0.5 but actual constant shows 0.0 for all — mismatch suggests stale/aspirational comment vs live code. No dependency on rule engine or DB layer; purely structural.

#### event.types.ts
*type* — Centralized event type definitions and boundary enforcement for all five subsystems; single source of truth for event vocabulary across the system.

Defines EventType union (57 event types grouped across Decision Making, Communication, Learning, Drive Engine, Planning, Metrics, Testing, System, Web); SubsystemSource (DECISION_MAKING, COMMUNICATION, LEARNING, DRIVE_ENGINE, PLANNING, SYSTEM, WEB); SylphieEvent base interface with id, type, timestamp, subsystem, sessionId, driveSnapshot, schemaVersion, correlationId, provenance; EVENT_BOUNDARY_MAP constant enforcing ownership (e.g., DECISION_CYCLE_STARTED → DECISION_MAKING); EVENT_TYPE_BOUNDARIES reverse map deriving subsystem→[EventType[]]; LearnableEvent extending SylphieEvent with hasLearnable, content, guardianFeedbackType, source, salience; ReinforcementEvent with required actionId (Contingency Requirement enforcement) and reinforcementPolarity; specialized events (GuardianConfirmationEvent, GuardianCorrectionEvent, ActionExecutedEvent, PredictionEvaluatedEvent, Type1DecisionEvent, Type2DecisionEvent, ArbitrationCompleteEvent); Web event payloads for WebSocket, health checks, chat, voice transcription/synthesis, graph queries, metrics queries. CANON compliance: Theater Prohibition (driveSnapshot on all events), Guardian Asymmetry (2x confirmation/3x correction), Contingency Requirement (actionId required on reinforcement), Immutable Standard 2 (actionId enforcement at type level).

- **Exports:** `SubsystemSource`, `EventType`, `EVENT_BOUNDARY_MAP`, `EVENT_TYPE_BOUNDARIES`, `validateEventBoundary`, `SylphieEvent`, `GuardianFeedbackType`, `LearnableEvent`, `ReinforcementEvent`, `GuardianConfirmationEvent`, `GuardianCorrectionEvent`, `ActionExecutedEvent`, `PredictionEvaluatedEvent`, `Type1DecisionEvent`, `Type2DecisionEvent`, `ArbitrationCompleteEvent`, `WsClientConnectedPayload`, `WsClientDisconnectedPayload`, `HealthCheckCompletedPayload`, `ChatInputReceivedPayload`, `ChatResponseSentPayload`, `VoiceTranscriptionCompletedPayload`, `VoiceSynthesisCompletedPayload`, `GraphQueryExecutedPayload`, `MetricsQueryExecutedPayload`
- **Key constants:** `57 EventType union members: DECISION_CYCLE_STARTED, TYPE_1_SELECTED, TYPE_2_SELECTED, SHRUG_SELECTED, ACTION_EXECUTED, PREDICTION_CREATED, PREDICTION_EVALUATED, EPISODE_ENCODED, TYPE_1_GRADUATION, TYPE_1_DEMOTION, TYPE_1_DECISION, TYPE_2_DECISION, ARBITRATION_COMPLETE, INPUT_RECEIVED, INPUT_PARSED, RESPONSE_GENERATED, RESPONSE_DELIVERED, GUARDIAN_CORRECTION, GUARDIAN_CONFIRMATION, SOCIAL_COMMENT_INITIATED, SOCIAL_CONTINGENCY_MET, GUARDIAN_TEACHING_DETECTED, CONSOLIDATION_CYCLE_STARTED, CONSOLIDATION_CYCLE_COMPLETED, ENTITY_EXTRACTED, EDGE_REFINED, CONTRADICTION_DETECTED, KNOWLEDGE_RETRIEVAL_AND_USE, REFLECTION_CYCLE_STARTED, REFLECTION_CYCLE_COMPLETED, REFLECTION_INSIGHT_CREATED, DRIVE_TICK, DRIVE_RULE_APPLIED, DRIVE_RELIEF, SELF_EVALUATION_RUN, OPPORTUNITY_DETECTED, RULE_PROPOSED, PREDICTION_ACCURACY_EVALUATED, OPPORTUNITY_RECEIVED, OPPORTUNITY_INTAKE, OPPORTUNITY_DROPPED, RESEARCH_COMPLETED, RESEARCH_INSUFFICIENT, SIMULATION_COMPLETED, SIMULATION_NO_VIABLE, PROPOSAL_GENERATED, PLAN_PROPOSED, PLAN_VALIDATED, PLAN_VALIDATION_FAILED, PLAN_EVALUATION, PLAN_CREATED, PLAN_FAILURE, PLANNING_RATE_LIMITED, BEHAVIORAL_DIVERSITY_SAMPLE, PREDICTION_MAE_SAMPLE, GUARDIAN_RESPONSE_LATENCY, TEST_STARTED, TEST_COMPLETED, LESION_ENABLED, LESION_DISABLED, BASELINE_CAPTURED, SESSION_STARTED, SESSION_ENDED, SCHEMA_MIGRATION, ERROR_RECOVERED, WS_CLIENT_CONNECTED, WS_CLIENT_DISCONNECTED, HEALTH_CHECK_COMPLETED, CHAT_INPUT_RECEIVED, CHAT_RESPONSE_SENT, VOICE_TRANSCRIPTION_COMPLETED, VOICE_SYNTHESIS_COMPLETED, GRAPH_QUERY_EXECUTED, METRICS_QUERY_EXECUTED; Guardian feedback weights: confirmation=2x, correction=3x (Standard 5); Learning cycle budget: max 5 learnable events per cycle; salience range: [0.0, 1.0]`
- **Deps:** `./drive.types (DriveSnapshot)`, `./provenance.types (ProvenanceSource)`
- **Gotchas:** No stubs; all types are fully defined and enforced. validateEventBoundary function provides runtime boundary validation. EVENT_TYPE_BOUNDARIES computed via IIFE with loop-based population—ensures sync between forward and reverse maps automatically. Reinforcement events mandate actionId at type level (no optional, no null) per Contingency Requirement (Standard 2). driveSnapshot required on all events per Theater Prohibition (Standard 1). GuardianConfirmationEvent and GuardianCorrectionEvent are intersection types (ReinforcementEvent & LearnableEvent) enforcing dual semantics.

#### index.ts
*barrel* — Central type export hub for sensory, drive, IPC, provenance, decision-making, communication, confidence, metrics, scene, memory, and LLM subsystems.

Re-exports type definitions and constants from 12 specialized type modules. Key subsystems: sensory-frame (VideoDetection, FaceDetection, SensoryFrame, EMBEDDING_DIM), drive.types (DriveName, DRIVE_RANGE, CORE_DRIVES, computeTotalPressure, PressureVector), ipc.types (DriveIPCMessage variants for Drive Engine isolation), provenance.types (OkgFactTier, resolveBaseConfidence, PROVENANCE_BASE_CONFIDENCE), decision-making.types (Episode, EpisodeInput, CognitiveContext, ConsolidationResult), communication.types (CycleResponse, KnowledgeGrounding), confidence.types (CONFIDENCE_THRESHOLDS, DEFAULT_DECAY_RATES, computeConfidence, applyGuardianWeight, qualifiesForGraduation/Demotion with ACTRParams), metrics.types (full re-export), scene.types (SceneEventType, TrackedObjectDTO, SceneSnapshot), working-memory.types (WorkingMemoryItem, WorkingMemorySnapshot), and llm.types (LlmTier, LlmRequest, LlmResponse, LlmContext, Type2CostEstimate, ILlmService, EpisodeSummary, WkgContextEntry, PersonModelSummary).

- **Exports:** `EMBEDDING_DIM`, `VideoDetection`, `FaceDetection`, `SensoryFrame`, `ModalityType`, `ModalityEncoder`, `DriveName`, `DRIVE_INDEX_ORDER`, `DRIVE_RANGE`, `CORE_DRIVES`, `COMPLEMENT_DRIVES`, `INITIAL_DRIVE_STATE`, `clampDriveValue`, `computeTotalPressure`, `PressureVector`, `PressureDelta`, `RuleMatchResult`, `DriveSnapshot`, `DriveIPCMessageType`, `DriveIPCMessage`, `ActionOutcomePayload`, `SoftwareMetricsPayload`, `SessionStartPayload`, `SessionEndPayload`, `DriveSnapshotPayload`, `OpportunityCreatedPayload`, `DriveEventPayload`, `HealthStatusPayload`, `OpportunityPriority`, `OpportunityClassification`, `CoreProvenanceSource`, `ExtendedProvenanceSource`, `ProvenanceSource`, `OkgFactSource`, `OkgFactTier`, `PROVENANCE_BASE_CONFIDENCE`, `resolveBaseConfidence`, `deriveOkgFactTier`, `*event.types`, `*action.types`, `EncodingDepth`, `EpisodeInput`, `Episode`, `EpisodeSource`, `VisualContext`, `Prediction`, `PredictionEvaluation`, `GapType`, `ShrugDetail`, `ContradictionScanResult`, `ContradictionEntry`, `ThresholdResult`, `CognitiveContext`, `ConsolidationCandidate`, `SemanticRelationship`, `SemanticConversion`, `ConsolidationResult`, `GraduationState`, `GraduationRecord`, `CycleResponse`, `InputParseResult`, `DeliveryPayload`, `KnowledgeGrounding`, `TurnOriginator`, `CONFIDENCE_THRESHOLDS`, `DEFAULT_DECAY_RATES`, `computeConfidence`, `applyGuardianWeight`, `qualifiesForGraduation`, `qualifiesForDemotion`, `ACTRParams`, `*metrics.types`, `SceneEventType`, `TrackedObjectDTO`, `SceneEvent`, `SceneSummary`, `SceneSnapshot`, `WorkingMemorySourceType`, `WorkingMemoryItem`, `WorkingMemorySnapshot`, `LLM_SERVICE`, `LlmTier`, `LlmMessage`, `LlmRequest`, `LlmCallMetadata`, `LlmResponse`, `EpisodeSummary`, `WkgContextEntry`, `PersonModelSummary`, `LlmContext`, `Type2CostEstimate`, `ILlmService`
- **Key constants:** `(see individual modules)`
- **Deps:** `./sensory-frame`, `./modality-encoder.interface`, `./drive.types`, `./ipc.types`, `./provenance.types`, `./event.types`, `./action.types`, `./decision-making.types`, `./communication.types`, `./confidence.types`, `./metrics.types`, `./scene.types`, `./working-memory.types`, `./llm.types`
- **Gotchas:** Barrel file only — all implementation and specifics deferred to child modules; no local logic or side effects.

#### ipc.types.ts
*type* — Defines the inter-process communication type contract for the Drive Engine isolation boundary.

Defines 8 message types crossing the Drive process boundary: ACTION_OUTCOME, SOFTWARE_METRICS, SESSION_START, SESSION_END (inbound) and DRIVE_SNAPSHOT, OPPORTUNITY_CREATED, DRIVE_EVENT, HEALTH_STATUS (outbound). ActionOutcomePayload (required fields: actionId, feedbackSource, theaterCheck, anxietyAtExecution) enforces CANON Standards 1-5: theater prohibition (zero-reinforce theatrical expressions when drive doesn't match), contingency requirement (actionId tracing), and guardian asymmetry (2x confirmation / 3x correction weighting). SoftwareMetricsPayload carries cognitiveEffortPressure [0.0, 1.0] to drive Type 1 graduation. OpportunityCreatedPayload (classification: PREDICTION_FAILURE_PATTERN | HIGH_IMPACT_ONE_OFF | BEHAVIORAL_NARROWING | GUARDIAN_TEACHING) routes to Planning queue with decay. DriveEventPayload (driveEventType: DRIVE_RELIEF | DRIVE_RULE_APPLIED | OPPORTUNITY_DETECTED | SELF_EVALUATION_RUN) carries delta and ruleId for subsystem awareness. Generic DriveIPCMessage<T> envelope wraps all payloads with type, payload, timestamp. Theater thresholds: pressure authentic if drive > 0.2, relief authentic if drive < 0.3.

- **Exports:** `DriveIPCMessageType`, `DriveIPCMessage`, `ActionOutcomePayload`, `SoftwareMetricsPayload`, `SessionStartPayload`, `SessionEndPayload`, `DriveSnapshotPayload`, `OpportunityPriority`, `OpportunityClassification`, `OpportunityCreatedPayload`, `DriveEventPayload`, `HealthStatusPayload`
- **Key constants:** `theater_pressure_threshold=0.2`, `theater_relief_threshold=0.3`, `guardian_confirmation_weight=2x`, `guardian_correction_weight=3x`, `algorithmic_weight=1x`, `anxiety_amplification_threshold=0.7`, `anxiety_reduction_multiplier=1.5x`, `socialCommentBonusWindow=30s`
- **Deps:** `./drive.types (DriveName, DriveSnapshot)`
- **Gotchas:** ActionOutcomePayload.actionId is REQUIRED (CANON Standard 2). feedbackSource is REQUIRED (CANON Standard 5). theaterCheck is REQUIRED (CANON Standard 1) with drive > 0.2 for pressure, < 0.3 for relief authenticity; theatrical outputs get zero-reinforcement. Optional fields: predictionData (E4-T009), informationGainMetrics, socialCommentTimestamp — missing fields degrade contingencies gracefully rather than failing. Anxiety > 0.7 + negative outcome triggers 1.5x confidence reduction (CANON A.15). Opportunity priority queue must decay per CANON Known Attractor States. No stubs detected.

#### llm.types.ts
*type* — LLM service interface, request/response types, cost estimation, and context assembly for Anthropic API calls across Communication, Learning, and Planning subsystems.

Defines LlmRequest (messages, systemPrompt, maxTokens, temperature, metadata, tier) and LlmResponse (content, tokensUsed broken into prompt/completion, latencyMs, model, cost in USD). LlmMessage models conversation turns (role + content). Type2CostEstimate provides upfront cognitive effort cost calculation. ILlmService interface specifies complete() for API calls (must report latency/tokens to Drive Engine), estimateCost() for pre-call budgeting, isAvailable() for Lesion Test support, enableLesionTest() and resetCircuitBreaker() for test mode control. LlmContext packages DriveSnapshot (required for Theater Prohibition validation), recentEpisodes, wkgContext, personModel, and conversationHistory. LlmCallMetadata carries callerSubsystem (COMMUNICATION|LEARNING|PLANNING), purpose string, sessionId, and optional correlationId for tracing. Model tier enum: quick/medium/deep mapping to Ollama env vars. No side effects; pure interface definition.

- **Exports:** `LLM_SERVICE`, `LlmTier`, `LlmMessage`, `LlmRequest`, `LlmCallMetadata`, `LlmResponse`, `EpisodeSummary`, `WkgContextEntry`, `PersonModelSummary`, `LlmContext`, `Type2CostEstimate`, `ILlmService`
- **Key constants:** `LlmTier: quick\|medium\|deep`, `callerSubsystem: COMMUNICATION\|LEARNING\|PLANNING`, `role: user\|assistant`
- **Deps:** `drive.types (DriveSnapshot)`
- **Gotchas:** File intentionally placed in src/shared/types not src/communication to avoid cross-subsystem import violation (Learning/Planning would couple to Communication). Concrete AnthropicLlmService implementation lives in src/communication and registers under LLM_SERVICE token. Theater Prohibition requires driveSnapshot in every LlmContext. Callers MUST report latencyMs and tokensUsed to Drive Engine post-call or violate Theater constraint. Lesion Test requires graceful degradation (Decision Making→SHRUG, Learning→skip, Planning→defer) when isAvailable() false. estimateCost() must be pure (no API call). Complete integration with cognitive effort pressure calculation and budget controls not shown.

#### metrics.types.ts
*type* — CANON health metrics type definitions — first-class types for 7 primary development metrics

Defines seven CANON §Development Metrics as TypeScript interfaces: (1) Type1Type2Ratio (graph reflex vs LLM decisions, ratio range [0,1], windowSize reliability threshold 10), (2) PredictionMAEMetric (world model accuracy 0-1, graduation requires MAE<0.10 over 10 uses, demotion at MAE>0.15), (3) ProvenanceRatio (WKG knowledge breakdown by SENSOR/GUARDIAN/INFERENCE/LLM_GENERATED, experiential ratio tracks self-constructed vs LLM-provided), (4) BehavioralDiversityIndex (unique action types per 20-action window, healthy range 4-8 types corresponding to index 0.20-0.40), (5) GuardianResponseRate (Sylphie-initiated comments receiving guardian response within 30s, measures quality of self-initiated conversation), (6) InteroceptiveAccuracy (self-reported drive state vs Drive Engine actual state, accuracy computed as 1.0 - |selfReported - actual|, target >0.6, enforces Theater Prohibition), (7) MeanDriveResolutionTime (per-drive average time from elevated pressure >0.5 to resolved <0.3, sample reliability threshold 5). HealthMetrics aggregate unites all seven with sessionId, computedAt, and partial map of drive resolution times. Zero dependencies, no imports. CANON drift-detection system requires type safety to compare metric trajectories across sessions.

- **Exports:** `Type1Type2Ratio`, `PredictionMAEMetric`, `ProvenanceRatio`, `BehavioralDiversityIndex`, `GuardianResponseRate`, `InteroceptiveAccuracy`, `MeanDriveResolutionTime`, `HealthMetrics`
- **Key constants:** `Type1 graduation threshold: MAE < 0.10 over 10 uses`, `Type1 demotion threshold: MAE > 0.15`, `Guardian response window: 30 seconds`, `Behavioral diversity healthy range: 4-8 types per 20-action window`, `Behavioral diversity index healthy range: 0.20-0.40`, `Interoceptive accuracy target: > 0.6`, `Drive pressure elevated: > 0.5`, `Drive pressure resolved: < 0.3`, `Minimum sample size Type1Type2Ratio: 10 decisions`, `Minimum sample size PredictionMAEMetric: 10 evaluations`, `Minimum sample size MeanDriveResolutionTime: 5 events`, `MAE range: [0.0, 1.0]`, `Behavioral diversity index range: (0.0, 1.0]`, `Interoceptive accuracy range: [0.0, 1.0]`
- **Gotchas:** No stubs or TODOs. MeanDriveResolutionTimes is partial map — drives with sampleCount < 5 omitted rather than unreliable. All metrics marked readonly. NaN possible in ratio/rate fields when denominators are zero (type1Count+type2Count=0 for ratio, initiated=0 for response rate, total=0 for provenance). No runtime validation of constants or threshold crossing — caller responsible for interpretation. Theater Prohibition enforced via type design (interoceptiveAccuracy) but not via guards at metric computation.

#### modality-encoder.interface.ts
*type* — Contract interface for sensory modality encoders that self-register with ModalityRegistryService

Defines ModalityEncoder<TRaw> generic interface with three members: readonly modalityName (unique identifier like 'text', 'drives', 'video'); readonly eventDriven boolean flag (true for event-driven like text that clears each tick, false for persistent like drives that retain latest value); and async encode(raw: TRaw) method returning Promise<number[]> to convert raw input into d-dimensional embedding vectors. Enables plugin architecture where new modalities register at startup without touching existing code. The fusion layer and tick sampler discover encoders through registry rather than hardcoded references.

- **Exports:** `ModalityEncoder`

#### provenance.types.ts
*type* — Canonical provenance source enumeration and confidence mapping for WKG node/edge provenance tracking per CANON §7.

Defines CoreProvenanceSource (SENSOR, GUARDIAN, LLM_GENERATED, INFERENCE), ExtendedProvenanceSource (GUARDIAN_APPROVED_INFERENCE, TAUGHT_PROCEDURE, BEHAVIORAL_INFERENCE, SYSTEM_BOOTSTRAP), and their union ProvenanceSource. Exports PROVENANCE_BASE_CONFIDENCE constant mapping core sources to initial confidence: SENSOR=0.40, GUARDIAN=0.60, LLM_GENERATED=0.35, INFERENCE=0.30. Provides resolveBaseConfidence(provenance) function to resolve any source (including extended) to its core confidence value. Also defines OkgFactSource (self_reported|observed|inferred), OkgFactTier interface, and deriveOkgFactTier(source, isGuardian) function implementing WS4-T5 CANON-compliant tiering: self_reported+guardian→0.90/GUARDIAN, self_reported→0.60/SELF_REPORTED, observed→0.60/OBSERVED, other→0.60/INFERENCE. Critical invariant: guardian status never lifts observed/inferred above 0.60 ceiling.

- **Exports:** `CoreProvenanceSource`, `ExtendedProvenanceSource`, `ProvenanceSource`, `PROVENANCE_BASE_CONFIDENCE`, `resolveBaseConfidence`, `OkgFactSource`, `OkgFactTier`, `deriveOkgFactTier`
- **Key constants:** `PROVENANCE_BASE_CONFIDENCE.SENSOR=0.40`, `PROVENANCE_BASE_CONFIDENCE.GUARDIAN=0.60`, `PROVENANCE_BASE_CONFIDENCE.LLM_GENERATED=0.35`, `PROVENANCE_BASE_CONFIDENCE.INFERENCE=0.30`
- **Gotchas:** File header states 'No cross-module imports' — zero-dependency foundation. WS4-T5 §1 implements CANON Standards 3 and 5 fix (identity-blind guardian-aware tiering). OkgFactTier provenanceType is free-form string, not DB enum. deriveOkgFactTier is pure/deterministic, unit-tested as WS4-T5 §6 A2/A3.

#### scene.types.ts
*type* — Scene-level types bridging raw per-frame detections to semantic scene understanding.

Defines four core interfaces: TrackedObjectDTO (single tracked object from Python perception service with bbox, embedding, state machine {tentative|confirmed|lost|deleted}, and optional face ID); SceneEvent (semantic events like OBJECT_APPEARED, PERSON_ARRIVED, FACE_IDENTIFIED); SceneSummary (frame aggregate: totals and counters); SceneSnapshot (complete frame state: timestamp, objects array, events array, summary). The synthetic flag (WS5 T0.8) marks perception cassette test frames for VWM to tag VisualObject nodes. TrackedObjectDTO carries 1280D EfficientNet-B0 embeddings (confirmed tracks only), bbox [x,y,w,h], frames tracking (framesSeen/framesLost), and null-aware timestamps.

- **Exports:** `TrackedObjectDTO`, `SceneEventType`, `SceneEvent`, `SceneSummary`, `SceneSnapshot`
- **Key constants:** `EfficientNet-B0 embedding dimension: 1280D`, `bbox format: [number, number, number, number]`, `state enum: tentative\|confirmed\|lost\|deleted`
- **Gotchas:** synthetic flag is data-carried (not GATE_MODE branch); atlas ruling 2026-06-13 keeps provenance_type as SENSOR, synthetic as distinct boolean; perception-reset deletes VisualObject {synthetic:true} nodes; embedding field only present when state=CONFIRMED

#### sensory-frame.ts
*type* — Defines core sensory frame and detection types for multimodal fusion pipeline

Exports VideoDetection (class, confidence, bbox), FaceDetection (confidence, bbox, 478 MediaPipe landmarks as [x,y] pixel coords, blendshapes 0-1 scores), and SensoryFrame (timestamp, fused_embedding d-dimensional gestalt of all modalities, modality_embeddings keyed by name, active_modalities array, raw values dict for TimescaleDB logging). Also exports EMBEDDING_DIM=768 constant and deprecated ModalityType enum ('text','video','drives'). No algorithms, DB writes, or network calls.

- **Exports:** `EMBEDDING_DIM`, `VideoDetection`, `FaceDetection`, `SensoryFrame`, `ModalityType`
- **Key constants:** `EMBEDDING_DIM=768`
- **Gotchas:** ModalityType marked deprecated, recommends string modality names from ModalityRegistry instead; landmarks and blendshapes may be null

#### working-memory.types.ts
*type* — Type definitions for activation-driven working memory buffer that selects relevant knowledge for deliberation.

Defines WorkingMemorySourceType (discriminator for item origin: WKG_FACT, WKG_ENTITY, EPISODE, DRIVE, SCENE, PROCEDURE). WorkingMemoryItem represents a single buffer item with id, sourceType, text, activation score [0.0-1.0], estimatedTokens, entityLabels, associatedDrives, sourceConfidence, sourceTimestamp, and spreadingBoost [0.0-0.20]. WorkingMemorySnapshot is an immutable snapshot consumed by deliberation with items sorted by activation descending, formattedSummary for LLM injection, sourceCounts diagnostics, totalEstimatedTokens, tokenBudget enforcement, evictedCount, assembledAt timestamp, and activatedEntities. Buffer enforces fixed capacity (slot + token budget), evicts lowest-activation items, maintains minimum source guarantees. Works as spotlight between raw sources (WKG, episodic, drives, perception) and deliberation pipeline, selecting not storing.

- **Exports:** `WorkingMemorySourceType`, `WorkingMemoryItem`, `WorkingMemorySnapshot`
- **Key constants:** `activation=[0.0-1.0]`, `spreadingBoost=[0.0-0.20]`

## Risks / stubs / TODOs

- `packages/shared/src/config/database.config.ts` — world/self/other neo4j endpoints have required env vars (non-falsy) but no fallback defaults; deployment must provide them or app will crash. pkg endpoint has full defaults for local dev. No validation of URI format or connectivity at config time.
- `packages/shared/src/config/ollama.config.ts` — No validation of env vars; parseable integers assumed for chatTimeoutMs; DEEPSEEK_API_KEY empty string means disabled (falsy check will pass); fallback chain on OLLAMA_CHAT_MODEL suggests legacy naming still supported; no error handling if env-configured models are unavailable at runtime.
- `packages/shared/src/config/voice.config.ts` — Deepgram API key has no default and falls back to empty string if unset; Elevenlabs API key similarly has no default; dependent services must validate these are set before use.
- `packages/shared/src/exceptions/domain.exceptions.ts` — All six classes follow identical constructor signature pattern; code defaults to 'UNKNOWN' per convention; subsystem names are hardcoded per class (knowledge, drive-engine, communication, learning, planning, decision-making)
- `packages/shared/src/exceptions/index.ts` — None. Pure barrel with import/export only.
- `packages/shared/src/exceptions/specific.exceptions.ts` — ContradictionDetectedError used only in code paths that cannot return discriminated union; normal WKG reads return union instead. All exceptions default code='UNKNOWN' when not explicitly provided. DriveCoherenceError validation thresholds hardcoded in docstring but checked in DriveReaderService (not this file). No side effects in exception constructors themselves.
- `packages/shared/src/exceptions/sylphie.exception.ts` — Error.cause is manually attached via type assertion because ES2022 Error.cause is not in ES2021 lib typings, though it is supported at runtime in Node 16+. All domain exceptions must extend this base class to maintain consistent error structure.
- `packages/shared/src/index.ts` — Wildcard exports from ./types and ./exceptions mask specific exported symbols; consumers cannot easily discover what is available without reading those modules
- `packages/shared/src/storage/neo4j.module.ts` — No error handling in forRootAsync() factory invocation; useFactory signature accepts variadic args but relies on injected dependencies being resolvable; no validation of Neo4jModuleConfig shape at module registration time.
- `packages/shared/src/storage/neo4j.service.ts` — Lazy reconnection on init failure: drivers.get() returns undefined if instance not found, throwing at getDriver time (no preemptive validation). No explicit error recovery in getSession if instance config lookup returns undefined—falls back to 'neo4j' database name silently. No connection pooling metrics or health checks exposed.
- `packages/shared/src/storage/prisma.service.ts` — No-op return on final connection failure (line 38) allows module to proceed with stale/disconnected client; subsequent queries will fail silently at query time rather than during init. onModuleDestroy disconnect is not awaited in NestJS lifecycle so slow disconnects may not complete. Log config ignores APP_ENV value and always uses [warn, error] (line 19-21 has dead branch).
- `packages/shared/src/storage/timescale.module.ts` — This is a pure module barrel — all actual logic/contracts live in timescale.service.ts; module itself is structural only
- `packages/shared/src/storage/timescale.service.ts` — onModuleInit() swallows fatal connection errors after 5 attempts (line 41-48) — logs error but returns normally, leaving pool in failed state; subsequent queries will fail. No explicit retry logic in query() itself, only at init. Config injection assumes 'timescale' key exists in ConfigService.
- `packages/shared/src/types/action.types.ts` — ActionProcedureData.confidence is a snapshot at retrieval time and does not update post-retrieval (must use IConfidenceService.recordUse for updates). ActionCandidate.driveRelevanceScore is optional with 0.0 default for candidates constructed outside the retriever. ArbitrationResult SHRUG variant must include shrugDetail for downstream systems (Communication, Planning) to act on specific incomprehension types. Theater validation failure results in zero reinforcement regardless of guardian response.
- `packages/shared/src/types/communication.types.ts` — WS4 Ticket 3: originator field is optional (undefined for self-initiated drive-pressure cycles, autonomous research). Theater Prohibition validation happens in Communication before delivery. groundingProvenance is OKG format attr-${personId}-${factKey} or WKG node_id; null when LLM_ASSISTED or UNKNOWN. Text field is empty string for SHRUG results, Communication decides how to express incomprehension. latentPatternIds populated only when new latent patterns written during cycle. Tensor metadata optional, only present if sidecar available. preExecutionDriveSnapshot needed for accurate driveEffectsObserved delta computation (WS3). No stubs present; fully wired per project conventions.
- `packages/shared/src/types/confidence.types.ts` — No side effects or I/O; pure functions only. Confidence Ceiling (Standard 3) enforces max 0.60 for count===0. Guardian Asymmetry (Standard 5) multipliers are structural and cannot be reduced by learning. Decay calculations assume hours-based time; lastRetrievalAt null implies count===0. No stubs or TODOs present; code is canonical and complete.
- `packages/shared/src/types/decision-making.types.ts` — EpisodeSource 'legacy' is deserialization-only sentinel (never stamped on fresh writes) to ensure per-episode provenance derivation is falsifiable; VisualContext sub-fields carry DIFFERENT provenance tiers (caption=LLM_GENERATED, sceneLabels=SENSOR, personIds=INFERENCE) and must never be collapsed to single episode-level tag; speakerId and speakerIsGuardian required for guardian-asymmetry ×2/×3 scoring and ×2/×3 prediction accuracy weighting; ContradictionScanResult currently defined but contradiction-scan pre-commit logic may be incomplete; graduatedAt/demotedAt timestamps allow null for never-transitioned procedures.
- `packages/shared/src/types/drive.types.ts` — INITIAL_DRIVE_STATE is all zeros (not the WS3 cold-start setup referenced in comments); comment mentions Curiosity=0.3 and Social=0.5 but actual constant shows 0.0 for all — mismatch suggests stale/aspirational comment vs live code. No dependency on rule engine or DB layer; purely structural.
- `packages/shared/src/types/event.types.ts` — No stubs; all types are fully defined and enforced. validateEventBoundary function provides runtime boundary validation. EVENT_TYPE_BOUNDARIES computed via IIFE with loop-based population—ensures sync between forward and reverse maps automatically. Reinforcement events mandate actionId at type level (no optional, no null) per Contingency Requirement (Standard 2). driveSnapshot required on all events per Theater Prohibition (Standard 1). GuardianConfirmationEvent and GuardianCorrectionEvent are intersection types (ReinforcementEvent & LearnableEvent) enforcing dual semantics.
- `packages/shared/src/types/index.ts` — Barrel file only — all implementation and specifics deferred to child modules; no local logic or side effects.
- `packages/shared/src/types/ipc.types.ts` — ActionOutcomePayload.actionId is REQUIRED (CANON Standard 2). feedbackSource is REQUIRED (CANON Standard 5). theaterCheck is REQUIRED (CANON Standard 1) with drive > 0.2 for pressure, < 0.3 for relief authenticity; theatrical outputs get zero-reinforcement. Optional fields: predictionData (E4-T009), informationGainMetrics, socialCommentTimestamp — missing fields degrade contingencies gracefully rather than failing. Anxiety > 0.7 + negative outcome triggers 1.5x confidence reduction (CANON A.15). Opportunity priority queue must decay per CANON Known Attractor States. No stubs detected.
- `packages/shared/src/types/llm.types.ts` — File intentionally placed in src/shared/types not src/communication to avoid cross-subsystem import violation (Learning/Planning would couple to Communication). Concrete AnthropicLlmService implementation lives in src/communication and registers under LLM_SERVICE token. Theater Prohibition requires driveSnapshot in every LlmContext. Callers MUST report latencyMs and tokensUsed to Drive Engine post-call or violate Theater constraint. Lesion Test requires graceful degradation (Decision Making→SHRUG, Learning→skip, Planning→defer) when isAvailable() false. estimateCost() must be pure (no API call). Complete integration with cognitive effort pressure calculation and budget controls not shown.
- `packages/shared/src/types/metrics.types.ts` — No stubs or TODOs. MeanDriveResolutionTimes is partial map — drives with sampleCount < 5 omitted rather than unreliable. All metrics marked readonly. NaN possible in ratio/rate fields when denominators are zero (type1Count+type2Count=0 for ratio, initiated=0 for response rate, total=0 for provenance). No runtime validation of constants or threshold crossing — caller responsible for interpretation. Theater Prohibition enforced via type design (interoceptiveAccuracy) but not via guards at metric computation.
- `packages/shared/src/types/provenance.types.ts` — File header states 'No cross-module imports' — zero-dependency foundation. WS4-T5 §1 implements CANON Standards 3 and 5 fix (identity-blind guardian-aware tiering). OkgFactTier provenanceType is free-form string, not DB enum. deriveOkgFactTier is pure/deterministic, unit-tested as WS4-T5 §6 A2/A3.
- `packages/shared/src/types/scene.types.ts` — synthetic flag is data-carried (not GATE_MODE branch); atlas ruling 2026-06-13 keeps provenance_type as SENSOR, synthetic as distinct boolean; perception-reset deletes VisualObject {synthetic:true} nodes; embedding field only present when state=CONFIRMED
- `packages/shared/src/types/sensory-frame.ts` — ModalityType marked deprecated, recommends string modality names from ModalityRegistry instead; landmarks and blendshapes may be null
- `packages/shared/src/verbose.ts` — logStream silently set to null if file write fails; verbose logging continues to stderr regardless. configure() runs once on import; users must call reconfigureVerbose() if env changes post-import or after dotenv loads late.

## Change log
- 2026-06-13 — Initial auto-generated map (32 files read in full).
