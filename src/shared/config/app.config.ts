/**
 * Application configuration using @nestjs/config's registerAs() factory pattern.
 *
 * All configuration reads from process.env. Sensible defaults match .env.example.
 * No class-validator instantiation — plain TypeScript interfaces with factory
 * functions that read from process.env at module load time.
 *
 * CANON constraint: Environment is the only valid source of configuration.
 * No hardcoded values in service files. If the environment is malformed, the
 * application surfaces it through missing/undefined values at startup.
 */

import { registerAs } from '@nestjs/config';

// ---------------------------------------------------------------------------
// Section Interfaces
// ---------------------------------------------------------------------------

/**
 * Neo4j World Knowledge Graph connection configuration.
 * The WKG is the architectural center of gravity — all subsystems read/write here.
 */
export interface Neo4jConfig {
  /** Bolt URI for the Neo4j instance. E.g., bolt://localhost:7687 */
  readonly uri: string;
  /** Database user. Default: 'neo4j' */
  readonly user: string;
  /** Database password. */
  readonly password: string;
  /** Target database name. Default: 'neo4j' */
  readonly database: string;
  /** Maximum number of connections in the Neo4j driver pool. Default: 50 */
  readonly maxConnectionPoolSize: number;
  /** Connection timeout in milliseconds. Default: 5000 */
  readonly connectionTimeoutMs: number;
}

/**
 * TimescaleDB event backbone configuration.
 * The event backbone — all five subsystems write here. Partitioned hypertable.
 */
export interface TimescaleConfig {
  /** Hostname for the TimescaleDB instance. Default: 'localhost' */
  readonly host: string;
  /** Port. Intentionally 5433 to avoid conflict with system Postgres. Default: 5433 */
  readonly port: number;
  /** Database name. Default: 'sylphie_events' */
  readonly database: string;
  /** Database user. Default: 'sylphie' */
  readonly user: string;
  /** Database password. */
  readonly password: string;
  /** Maximum number of connections in the pool. Default: 20 */
  readonly maxConnections: number;
  /** Idle connection timeout in milliseconds. Default: 30000 */
  readonly idleTimeoutMs: number;
  /** Connection acquisition timeout in milliseconds. Default: 5000 */
  readonly connectionTimeoutMs: number;
  /** Raw event retention in days. Default: 90 */
  readonly retentionDays: number;
  /** Days before compression is applied to historical data. Default: 7 */
  readonly compressionDays: number;
}

/**
 * PostgreSQL system database configuration.
 *
 * Three-pool architecture with role-based access control (CANON §Architecture):
 * - Admin pool: DDL and DML. Used for migrations and guardian-approved rule changes.
 * - Runtime pool (sylphie_app): SELECT on drive_rules, INSERT on proposed_drive_rules via RLS.
 * - Drive Engine pool (drive_engine): SELECT-only on both tables via RLS.
 *
 * This architecture enforces the No Self-Modification principle (CANON Immutable Standard 6)
 * at the database level. Role-based RLS policies prevent unauthorized modifications.
 *
 * Credential management via environment variables:
 * - POSTGRES_ADMIN_USER / POSTGRES_ADMIN_PASSWORD
 * - POSTGRES_SYLPHIE_APP_USER / POSTGRES_SYLPHIE_APP_PASSWORD
 * - POSTGRES_DRIVE_ENGINE_USER / POSTGRES_DRIVE_ENGINE_PASSWORD
 */
export interface PostgresConfig {
  /** Hostname. Default: 'localhost' */
  readonly host: string;
  /** Port. Default: 5434 (separate from TimescaleDB on 5433) */
  readonly port: number;
  /** Database name. Default: 'sylphie_system' */
  readonly database: string;
  /** Admin pool user (DDL + DML). */
  readonly adminUser: string;
  /** Admin pool password. */
  readonly adminPassword: string;
  /** Runtime pool user (SELECT-only on drive_rules via RLS). */
  readonly runtimeUser: string;
  /** Runtime pool password. */
  readonly runtimePassword: string;
  /** Drive Engine pool user (SELECT-only on drive_rules and proposed_drive_rules via RLS). */
  readonly driveEngineUser: string;
  /** Drive Engine pool password. */
  readonly driveEnginePassword: string;
  /** Guardian admin user (full permissions on drive_rules for approvals). */
  readonly guardianAdminUser: string;
  /** Guardian admin password. */
  readonly guardianAdminPassword: string;
  /** Maximum connections across all pools combined. Default: 10 */
  readonly maxConnections: number;
  /** Idle connection timeout in milliseconds. Default: 30000 */
  readonly idleTimeoutMs: number;
  /** Connection acquisition timeout in milliseconds. Default: 5000 */
  readonly connectionTimeoutMs: number;
}

/**
 * Grafeo configuration for Self KG and Other KGs.
 *
 * Grafeo runs embedded inside the NestJS process — no separate container.
 * Self KG and Other KGs are completely isolated from each other and from the WKG
 * (CANON §Architecture: no shared edges, no cross-contamination).
 */
export interface GrafeoConfig {
  /** Filesystem path for KG(Self). Default: './data/self-kg' */
  readonly selfKgPath: string;
  /** Filesystem path root for per-person Other KGs. Default: './data/other-kgs' */
  readonly otherKgPath: string;
  /** Maximum nodes per KG instance before write-protection triggers. Default: 10000 */
  readonly maxNodesPerKg: number;
}

/**
 * Planning subsystem configuration.
 *
 * CANON §Subsystem 5 (Planning): Triggered by Opportunities detected by the
 * Drive Engine. Researches failure patterns, simulates outcomes, validates
 * proposed plans via LLM constraint checking, and creates new procedure
 * nodes in the WKG with LLM_GENERATED provenance at confidence 0.35.
 *
 * Rate limiter and queue configuration prevent the Planning Runaway
 * and Prediction Pessimist attractor states.
 */
export interface PlanningConfig {
  /** Maximum plans per window. Default: 3 */
  readonly maxPlansPerWindow: number;
  /** Window duration in milliseconds. Default: 3600000 (1 hour) */
  readonly windowDurationMs: number;
  /** Maximum active plans (created but not evaluated). Default: 10 */
  readonly maxActivePlans: number;
  /** Maximum tokens per plan for LLM validation. Default: 4000 */
  readonly maxTokensPerPlan: number;
  /** Maximum opportunities in the queue. Default: 50 */
  readonly queueMaxSize: number;
  /** Priority decay rate per hour [0.0, 1.0]. Default: 0.10 */
  readonly queueDecayRatePerHour: number;
  /** Minimum priority threshold for queue retention. Default: 0.01 */
  readonly queueMinPriority: number;
  /** Cold-start opportunity threshold. Default: 100 */
  readonly coldStartThreshold: number;
  /** Cold-start dampening multiplier [0.0, 1.0]. Default: 0.8 */
  readonly coldStartInitialDampening: number;
  /** Research time window in days for historical data. Default: 7 */
  readonly researchTimeWindowDays: number;
  /** Minimum failures required to establish evidence. Default: 2 */
  readonly minFailuresForEvidence: number;
  /** Minimum expected value threshold for viable outcomes. Default: 0.3 */
  readonly simulationMinExpectedValue: number;
  /** Maximum proposal revision attempts. Default: 2 */
  readonly maxProposalRevisions: number;
  /** Queue processing interval in milliseconds. Default: 5000 */
  readonly processingIntervalMs: number;
}

/**
 * LLM (Anthropic Claude API) configuration.
 *
 * CANON §Architecture: The LLM is Sylphie's voice, not her mind.
 * Used only for Type 2 deliberation, Learning refinement, and Communication
 * response generation. Never for decision making.
 */
export interface LlmConfig {
  /** Which LLM provider to use. 'ollama' (default) or 'anthropic'. */
  readonly provider: 'ollama' | 'anthropic';
  /** Anthropic API key. Required when provider=anthropic. */
  readonly anthropicApiKey: string;
  /** Model identifier for Anthropic. Default: 'claude-sonnet-4-20250514' */
  readonly model: string;
  /** Maximum tokens for Type 2 deliberation calls. Default: 4096 */
  readonly maxTokens: number;
  /** Default sampling temperature. Default: 0.7 */
  readonly temperature: number;
  /** Whether to track API call costs. Default: true */
  readonly costTrackingEnabled: boolean;
}

/**
 * Ollama local inference configuration.
 *
 * Two-model architecture:
 *   - GPU model: Slow but capable. Used for Type 2 deliberation, Learning,
 *     and Planning where reasoning quality matters.
 *   - CPU model: Fast and lightweight. Used for conversation response
 *     generation where latency matters more than depth.
 */
export interface OllamaConfig {
  /** Base URL for the Ollama HTTP API. Default: 'http://localhost:11434' */
  readonly baseUrl: string;
  /** GPU model for high-inference tasks (Type 2, Learning, Planning). */
  readonly gpuModel: string;
  /** CPU model for fast/lightweight tasks (conversation responses). */
  readonly cpuModel: string;
}

/**
 * Deepgram STT configuration.
 *
 * CANON §Communication: Voice is the preferred channel, not the only channel.
 * Voice failures never block system operation (graceful degradation).
 */
export interface DeepgramConfig {
  /** Deepgram API key. Required for STT calls. */
  readonly apiKey: string;
}

/**
 * ElevenLabs TTS configuration.
 */
export interface ElevenLabsConfig {
  /** ElevenLabs API key. Required for TTS calls. */
  readonly apiKey: string;
  /** Voice ID for synthesis. */
  readonly voiceId: string;
  /** Model ID. Default: 'eleven_monolingual_v1' */
  readonly modelId: string;
}

/**
 * OpenAI Voice API configuration (legacy, kept for backward compatibility).
 *
 * CANON §Communication: Voice is the preferred channel, not the only channel.
 * Voice failures never block system operation (graceful degradation).
 */
export interface OpenAiVoiceConfig {
  /** OpenAI API key. Required for Whisper and TTS calls. */
  readonly apiKey: string;
  /** Default voice for TTS. Options: alloy, echo, fable, onyx, nova, shimmer. Default: nova */
  readonly defaultVoice: string;
  /** Default audio format for TTS. Options: mp3, opus, aac, flac. Default: mp3 */
  readonly defaultFormat: 'mp3' | 'opus' | 'aac' | 'flac';
  /** Default speech rate multiplier for TTS. Range [0.25, 4.0]. Default: 1.0 */
  readonly defaultSpeed: number;
}

/**
 * WebRTC and camera media configuration.
 *
 * Used by MediaModule to configure ICE servers for WebRTC peer connections
 * and the optional camera device for video capture.
 *
 * CANON §Startup: Missing or empty STUN server configuration is a startup
 * WARNING, not a crash. Media features are optional and must degrade gracefully.
 */
export interface MediaConfig {
  /**
   * List of STUN server URIs for ICE negotiation.
   * Read from MEDIA_STUN_SERVERS (comma-separated).
   * Default: ['stun:stun.l.google.com:19302']
   */
  readonly stunServers: string[];
  /**
   * Optional TURN server URI for relay fallback.
   * Read from MEDIA_TURN_SERVER. Omitted when unset.
   */
  readonly turnServer?: string;
  /**
   * TURN server credential username.
   * Read from MEDIA_TURN_USERNAME. Omitted when unset.
   */
  readonly turnUsername?: string;
  /**
   * TURN server credential password.
   * Read from MEDIA_TURN_PASSWORD. Omitted when unset.
   */
  readonly turnPassword?: string;
  /**
   * OS device ID for the webcam.
   * Read from CAMERA_DEVICE_ID. Omitted when unset.
   */
  readonly cameraDeviceId?: string;
  /**
   * Target camera capture frame rate.
   * Read from CAMERA_FPS. Default: 15
   */
  readonly cameraFps: number;
}

/**
 * Top-level application configuration.
 */
export interface AppSectionConfig {
  /** HTTP port the NestJS server listens on. Default: 3000 */
  readonly port: number;
  /** Runtime environment. Default: 'development' */
  readonly env: string;
  /** Log level. Default: 'debug' */
  readonly logLevel: string;
  /** Initial session identifier. Default: 'dev-session-001' */
  readonly sessionId: string;
}

/**
 * Root application configuration shape — the full object returned by appConfig().
 * All subsections are present after load.
 */
export interface AppConfig {
  readonly app: AppSectionConfig;
  readonly neo4j: Neo4jConfig;
  readonly timescale: TimescaleConfig;
  readonly postgres: PostgresConfig;
  readonly grafeo: GrafeoConfig;
  readonly planning: PlanningConfig;
  readonly llm: LlmConfig;
  readonly ollama: OllamaConfig;
  readonly deepgram: DeepgramConfig;
  readonly elevenlabs: ElevenLabsConfig;
  readonly openaiVoice: OpenAiVoiceConfig;
  readonly media: MediaConfig;
}

// ---------------------------------------------------------------------------
// registerAs() Factory
// ---------------------------------------------------------------------------

/**
 * NestJS @nestjs/config factory for the full application configuration.
 *
 * Registered under the key 'app' in ConfigModule. All values are read from
 * process.env with defaults matching .env.example. No validation library
 * instantiation — this is intentionally lightweight for E0.
 *
 * Usage in services:
 *   constructor(private readonly config: ConfigService) {}
 *   const neo4jUri = this.config.get<AppConfig>('app')?.neo4j.uri;
 *
 * @returns Fully resolved AppConfig from environment variables
 */
export const appConfig = registerAs('app', (): AppConfig => ({
  app: {
    port: parseInt(process.env['APP_PORT'] ?? '3000', 10),
    env: process.env['APP_ENV'] ?? 'development',
    logLevel: process.env['APP_LOG_LEVEL'] ?? 'debug',
    sessionId: process.env['SESSION_ID'] ?? 'dev-session-001',
  },

  neo4j: {
    uri: process.env['NEO4J_URI'] ?? 'bolt://localhost:7687',
    user: process.env['NEO4J_USER'] ?? 'neo4j',
    password: process.env['NEO4J_PASSWORD'] ?? '',
    database: process.env['NEO4J_DATABASE'] ?? 'neo4j',
    maxConnectionPoolSize: parseInt(
      process.env['NEO4J_MAX_CONNECTION_POOL_SIZE'] ?? '50',
      10,
    ),
    connectionTimeoutMs: parseInt(
      process.env['NEO4J_CONNECTION_TIMEOUT_MS'] ?? '5000',
      10,
    ),
  },

  timescale: {
    host: process.env['TIMESCALE_HOST'] ?? 'localhost',
    port: parseInt(process.env['TIMESCALE_PORT'] ?? '5433', 10),
    database: process.env['TIMESCALE_DB'] ?? 'sylphie_events',
    user: process.env['TIMESCALE_USER'] ?? 'sylphie',
    password: process.env['TIMESCALE_PASSWORD'] ?? '',
    maxConnections: parseInt(
      process.env['TIMESCALE_MAX_CONNECTIONS'] ?? '20',
      10,
    ),
    idleTimeoutMs: parseInt(
      process.env['TIMESCALE_IDLE_TIMEOUT_MS'] ?? '30000',
      10,
    ),
    connectionTimeoutMs: parseInt(
      process.env['TIMESCALE_CONNECTION_TIMEOUT_MS'] ?? '5000',
      10,
    ),
    retentionDays: parseInt(
      process.env['TIMESCALE_RETENTION_DAYS'] ?? '90',
      10,
    ),
    compressionDays: parseInt(
      process.env['TIMESCALE_COMPRESSION_DAYS'] ?? '7',
      10,
    ),
  },

  postgres: {
    host: process.env['POSTGRES_HOST'] ?? 'localhost',
    port: parseInt(process.env['POSTGRES_PORT'] ?? '5434', 10),
    database: process.env['POSTGRES_DB'] ?? 'sylphie_system',
    adminUser: process.env['POSTGRES_ADMIN_USER'] ?? '',
    adminPassword: process.env['POSTGRES_ADMIN_PASSWORD'] ?? '',
    runtimeUser: process.env['POSTGRES_RUNTIME_USER'] ?? '',
    runtimePassword: process.env['POSTGRES_RUNTIME_PASSWORD'] ?? '',
    driveEngineUser: process.env['POSTGRES_DRIVE_ENGINE_USER'] ?? '',
    driveEnginePassword: process.env['POSTGRES_DRIVE_ENGINE_PASSWORD'] ?? '',
    guardianAdminUser: process.env['POSTGRES_GUARDIAN_ADMIN_USER'] ?? '',
    guardianAdminPassword: process.env['POSTGRES_GUARDIAN_ADMIN_PASSWORD'] ?? '',
    maxConnections: parseInt(
      process.env['POSTGRES_MAX_CONNECTIONS'] ?? '10',
      10,
    ),
    idleTimeoutMs: parseInt(
      process.env['POSTGRES_IDLE_TIMEOUT_MS'] ?? '30000',
      10,
    ),
    connectionTimeoutMs: parseInt(
      process.env['POSTGRES_CONNECTION_TIMEOUT_MS'] ?? '5000',
      10,
    ),
  },

  grafeo: {
    selfKgPath: process.env['GRAFEO_SELF_KG_PATH'] ?? './data/self-kg',
    otherKgPath: process.env['GRAFEO_OTHER_KG_PATH'] ?? './data/other-kgs',
    maxNodesPerKg: parseInt(
      process.env['GRAFEO_MAX_NODES_PER_KG'] ?? '10000',
      10,
    ),
  },

  planning: {
    maxPlansPerWindow: parseInt(
      process.env['PLANNING_MAX_PLANS_PER_WINDOW'] ?? '3',
      10,
    ),
    windowDurationMs: parseInt(
      process.env['PLANNING_WINDOW_DURATION_MS'] ?? '3600000',
      10,
    ),
    maxActivePlans: parseInt(process.env['PLANNING_MAX_ACTIVE_PLANS'] ?? '10', 10),
    maxTokensPerPlan: parseInt(
      process.env['PLANNING_MAX_TOKENS_PER_PLAN'] ?? '4000',
      10,
    ),
    queueMaxSize: parseInt(
      process.env['PLANNING_QUEUE_MAX_SIZE'] ?? '50',
      10,
    ),
    queueDecayRatePerHour: parseFloat(
      process.env['PLANNING_QUEUE_DECAY_RATE_PER_HOUR'] ?? '0.10',
    ),
    queueMinPriority: parseFloat(
      process.env['PLANNING_QUEUE_MIN_PRIORITY'] ?? '0.01',
    ),
    coldStartThreshold: parseInt(
      process.env['PLANNING_COLD_START_THRESHOLD'] ?? '100',
      10,
    ),
    coldStartInitialDampening: parseFloat(
      process.env['PLANNING_COLD_START_INITIAL_DAMPENING'] ?? '0.8',
    ),
    researchTimeWindowDays: parseInt(
      process.env['PLANNING_RESEARCH_TIME_WINDOW_DAYS'] ?? '7',
      10,
    ),
    minFailuresForEvidence: parseInt(
      process.env['PLANNING_MIN_FAILURES_FOR_EVIDENCE'] ?? '2',
      10,
    ),
    simulationMinExpectedValue: parseFloat(
      process.env['PLANNING_SIMULATION_MIN_EXPECTED_VALUE'] ?? '0.3',
    ),
    maxProposalRevisions: parseInt(
      process.env['PLANNING_MAX_PROPOSAL_REVISIONS'] ?? '2',
      10,
    ),
    processingIntervalMs: parseInt(
      process.env['PLANNING_PROCESSING_INTERVAL_MS'] ?? '5000',
      10,
    ),
  },

  llm: {
    provider: (process.env['LLM_PROVIDER'] ?? 'ollama') as 'ollama' | 'anthropic',
    anthropicApiKey: process.env['ANTHROPIC_API_KEY'] ?? '',
    model: process.env['LLM_MODEL'] ?? 'claude-sonnet-4-20250514',
    maxTokens: parseInt(process.env['LLM_MAX_TOKENS'] ?? '4096', 10),
    temperature: parseFloat(process.env['LLM_TEMPERATURE'] ?? '0.7'),
    costTrackingEnabled:
      (process.env['LLM_COST_TRACKING_ENABLED'] ?? 'true') === 'true',
  },

  ollama: {
    baseUrl: process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434',
    gpuModel: process.env['OLLAMA_GPU_MODEL'] ?? 'gemma3:27b',
    cpuModel: process.env['OLLAMA_CPU_MODEL'] ?? 'qwen2.5:7b',
  },

  deepgram: {
    apiKey: process.env['DEEPGRAM_API_KEY'] ?? '',
  },

  elevenlabs: {
    apiKey: process.env['ELEVENLABS_API_KEY'] ?? '',
    voiceId: process.env['ELEVENLABS_VOICE_ID'] ?? '',
    modelId: process.env['ELEVENLABS_MODEL_ID'] ?? 'eleven_monolingual_v1',
  },

  openaiVoice: {
    apiKey: process.env['OPENAI_API_KEY'] ?? '',
    defaultVoice: process.env['OPENAI_TTS_DEFAULT_VOICE'] ?? 'nova',
    defaultFormat: (process.env['OPENAI_TTS_DEFAULT_FORMAT'] ?? 'mp3') as
      | 'mp3'
      | 'opus'
      | 'aac'
      | 'flac',
    defaultSpeed: parseFloat(process.env['OPENAI_TTS_DEFAULT_SPEED'] ?? '1.0'),
  },

  media: {
    stunServers: (
      process.env['MEDIA_STUN_SERVERS'] ?? 'stun:stun.l.google.com:19302'
    )
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    turnServer: process.env['MEDIA_TURN_SERVER'] || undefined,
    turnUsername: process.env['MEDIA_TURN_USERNAME'] || undefined,
    turnPassword: process.env['MEDIA_TURN_PASSWORD'] || undefined,
    cameraDeviceId: process.env['CAMERA_DEVICE_ID'] || undefined,
    cameraFps: parseInt(process.env['CAMERA_FPS'] ?? '15', 10),
  },
}));
