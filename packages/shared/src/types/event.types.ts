/**
 * Event system types: the shared vocabulary for all five subsystems.
 *
 * CANON §TimescaleDB — The Event Backbone: Every subsystem writes to TimescaleDB.
 * EventType is the single centralized source of truth for all event type strings.
 * No string literals for event types anywhere else in the codebase — import EventType here.
 *
 * CANON Immutable Standard 2 (Contingency Requirement): Every positive reinforcement
 * event must trace to a specific behavior. Reinforcement subtypes therefore carry
 * a required actionId field — this is enforced at the type level, not just convention.
 *
 * Zero dependencies beyond drive.types.ts (for DriveSnapshot).
 */

import type { DriveSnapshot } from './drive.types';
import type { ProvenanceSource } from './provenance.types';

// ---------------------------------------------------------------------------
// Subsystem Source
// ---------------------------------------------------------------------------

/**
 * The subsystems that produce events. Every SylphieEvent declares which
 * subsystem emitted it. Used for stream separation and cross-subsystem attribution.
 *
 * The five core subsystems plus SYSTEM for infra-level events (boot, shutdown,
 * migrations, error recovery).
 *
 * CANON §Architecture: Five Subsystems.
 */
export type SubsystemSource =
  | 'DECISION_MAKING'
  | 'COMMUNICATION'
  | 'LEARNING'
  | 'DRIVE_ENGINE'
  | 'PLANNING'
  | 'SYSTEM'
  | 'WEB';

// ---------------------------------------------------------------------------
// EventType — Single Source of Truth
// ---------------------------------------------------------------------------

/**
 * Centralized union of all event type strings for the entire system.
 *
 * CANON (Ashby stigmergic channel legibility): A single source of truth for
 * event type strings prevents drift between subsystems and enables compile-time
 * verification that all event type references are valid.
 *
 * Grouped by subsystem for readability. The EVENT_BOUNDARY_MAP below enforces
 * which subsystem owns each event type.
 *
 * -- Decision Making (13 types) --
 * DECISION_CYCLE_STARTED: A new processing cycle has begun.
 * TYPE_1_SELECTED: A Type 1 (graph reflex) action was selected by arbitration.
 * TYPE_2_SELECTED: A Type 2 (LLM-deliberative) action was selected by arbitration.
 * SHRUG_SELECTED: No candidate exceeded threshold; Shrug Imperative applied (Standard 4).
 * ACTION_EXECUTED: An action has been dispatched to the executor.
 * PREDICTION_CREATED: A prediction about future state was stored.
 * PREDICTION_EVALUATED: A prediction was compared against observed outcome.
 * EPISODE_ENCODED: An experience was committed to episodic memory.
 * TYPE_1_GRADUATION: A behavior graduated from Type 2 to Type 1.
 * TYPE_1_DEMOTION: A behavior was demoted from Type 1 back to Type 2.
 * TYPE_1_DECISION: Rich payload event emitted when a Type 1 action is confirmed for execution.
 *   Carries actionType, confidence, and optional contextFingerprint for Observatory queries.
 * TYPE_2_DECISION: Rich payload event emitted when a Type 2 action is confirmed for execution.
 *   Carries actionType, confidence, llmLatencyMs, and optional contextFingerprint.
 * ARBITRATION_COMPLETE: Summary event emitted once arbitration resolves to any outcome.
 *   Carries winner (type1/type2/shrug), both confidence values, and the dynamic threshold.
 *
 * -- Communication (8 types) --
 * INPUT_RECEIVED: Raw input (text or transcribed audio) arrived.
 * INPUT_PARSED: Input was parsed into structured intent by InputParser.
 * RESPONSE_GENERATED: LLM produced a response candidate.
 * RESPONSE_DELIVERED: Response was committed to output (TTS/chatbox).
 * GUARDIAN_CORRECTION: Guardian corrected Sylphie's behavior or output (3x weight).
 * GUARDIAN_CONFIRMATION: Guardian confirmed Sylphie's behavior or output (2x weight).
 * SOCIAL_COMMENT_INITIATED: Sylphie initiated a comment without prompting.
 * SOCIAL_CONTINGENCY_MET: Guardian responded to Sylphie-initiated comment within 30s.
 *
 * -- Learning (6 types) --
 * CONSOLIDATION_CYCLE_STARTED: A maintenance/consolidation cycle began.
 * CONSOLIDATION_CYCLE_COMPLETED: Maintenance cycle finished; summary available.
 * ENTITY_EXTRACTED: An entity was extracted from conversational content.
 * EDGE_REFINED: An edge in the WKG was refined by the Learning subsystem.
 * CONTRADICTION_DETECTED: A contradiction between new and existing knowledge was found.
 * KNOWLEDGE_RETRIEVAL_AND_USE: A WKG node/edge was successfully retrieved and used.
 *
 * -- Drive Engine (7 types) --
 * DRIVE_TICK: The Drive Engine completed one computation tick.
 * DRIVE_RULE_APPLIED: A specific Postgres drive rule was matched and applied.
 * DRIVE_RELIEF: A drive value decreased (need was satisfied).
 * SELF_EVALUATION_RUN: KG(Self) self-evaluation cycle executed.
 * OPPORTUNITY_DETECTED: A recurring pattern was promoted to an Opportunity.
 * RULE_PROPOSED: A new drive rule was proposed for guardian review.
 * PREDICTION_ACCURACY_EVALUATED: Drive Engine evaluated prediction accuracy for a cycle.
 *
 * -- Planning (13 types) --
 * OPPORTUNITY_RECEIVED: An opportunity was received from the Drive Engine.
 * OPPORTUNITY_INTAKE: Planning subsystem accepted a new Opportunity into the queue.
 * OPPORTUNITY_DROPPED: An opportunity was dropped from the queue due to decay or low priority.
 * RESEARCH_COMPLETED: The research phase finished gathering evidence.
 * RESEARCH_INSUFFICIENT: The research phase found insufficient evidence to proceed.
 * SIMULATION_COMPLETED: An outcome simulation finished.
 * SIMULATION_NO_VIABLE: Simulation produced no viable outcomes above threshold.
 * PROPOSAL_GENERATED: A plan proposal was generated from research and simulation.
 * PLAN_PROPOSED: A plan was assembled and submitted for LLM constraint validation.
 * PLAN_VALIDATED: LLM constraint engine approved a proposed plan.
 * PLAN_VALIDATION_FAILED: LLM constraint engine rejected a proposed plan.
 * PLAN_EVALUATION: A created procedure was evaluated after execution.
 * PLAN_CREATED: A validated plan was committed as a procedure node in the WKG.
 * PLAN_FAILURE: A created procedure failed during execution.
 * PLANNING_RATE_LIMITED: Planning pipeline declined an opportunity due to rate limits.
 *
 * -- Metrics (3 types, per CANON Gap 6) --
 * BEHAVIORAL_DIVERSITY_SAMPLE: A snapshot of action-type diversity was recorded.
 * PREDICTION_MAE_SAMPLE: A snapshot of prediction MAE was recorded.
 * GUARDIAN_RESPONSE_LATENCY: Guardian response latency to a Sylphie-initiated comment.
 *
 * -- Testing (5 types, per CANON Phase 1 Must Prove) --
 * TEST_STARTED: A test environment was bootstrapped in a specific lesion mode.
 * TEST_COMPLETED: A test run finished and was torn down cleanly.
 * LESION_ENABLED: A subsystem lesion (disable) was successfully applied.
 * LESION_DISABLED: A subsystem lesion was removed and system restored.
 * BASELINE_CAPTURED: A development baseline was captured for drift detection.
 *
 * -- System (4 types) --
 * SESSION_STARTED: Sylphie session (runtime) started.
 * SESSION_ENDED: Sylphie session (runtime) ended cleanly.
 * SCHEMA_MIGRATION: A schema migration or system upgrade was executed.
 * ERROR_RECOVERED: A system error was caught and recovery executed.
 *
 * -- Web (9 types) --
 * WS_CLIENT_CONNECTED: A WebSocket client connected to the server.
 * WS_CLIENT_DISCONNECTED: A WebSocket client disconnected from the server.
 * HEALTH_CHECK_COMPLETED: A system health check cycle completed.
 * CHAT_INPUT_RECEIVED: User input was received via the chat interface.
 * CHAT_RESPONSE_SENT: A response was sent back to the chat client.
 * VOICE_TRANSCRIPTION_COMPLETED: Voice audio was transcribed to text.
 * VOICE_SYNTHESIS_COMPLETED: Text was synthesized to voice audio.
 * GRAPH_QUERY_EXECUTED: A query against the knowledge graph completed.
 * METRICS_QUERY_EXECUTED: A system metrics query was executed.
 */
export type EventType =
  // Decision Making
  | 'DECISION_CYCLE_STARTED'
  | 'TYPE_1_SELECTED'
  | 'TYPE_2_SELECTED'
  | 'SHRUG_SELECTED'
  | 'ACTION_EXECUTED'
  | 'PREDICTION_CREATED'
  | 'PREDICTION_EVALUATED'
  | 'EPISODE_ENCODED'
  | 'TYPE_1_GRADUATION'
  | 'TYPE_1_DEMOTION'
  | 'TYPE_1_DECISION'
  | 'TYPE_2_DECISION'
  | 'ARBITRATION_COMPLETE'
  // Communication
  | 'INPUT_RECEIVED'
  | 'INPUT_PARSED'
  | 'RESPONSE_GENERATED'
  | 'RESPONSE_DELIVERED'
  | 'GUARDIAN_CORRECTION'
  | 'GUARDIAN_CONFIRMATION'
  | 'SOCIAL_COMMENT_INITIATED'
  | 'SOCIAL_CONTINGENCY_MET'
  // Learning
  | 'CONSOLIDATION_CYCLE_STARTED'
  | 'CONSOLIDATION_CYCLE_COMPLETED'
  | 'ENTITY_EXTRACTED'
  | 'EDGE_REFINED'
  | 'CONTRADICTION_DETECTED'
  | 'KNOWLEDGE_RETRIEVAL_AND_USE'
  // Drive Engine
  | 'DRIVE_TICK'
  | 'DRIVE_RULE_APPLIED'
  | 'DRIVE_RELIEF'
  | 'SELF_EVALUATION_RUN'
  | 'OPPORTUNITY_DETECTED'
  | 'RULE_PROPOSED'
  | 'PREDICTION_ACCURACY_EVALUATED'
  // Planning
  | 'OPPORTUNITY_RECEIVED'
  | 'OPPORTUNITY_INTAKE'
  | 'OPPORTUNITY_DROPPED'
  | 'RESEARCH_COMPLETED'
  | 'RESEARCH_INSUFFICIENT'
  | 'SIMULATION_COMPLETED'
  | 'SIMULATION_NO_VIABLE'
  | 'PROPOSAL_GENERATED'
  | 'PLAN_PROPOSED'
  | 'PLAN_VALIDATED'
  | 'PLAN_VALIDATION_FAILED'
  | 'PLAN_EVALUATION'
  | 'PLAN_CREATED'
  | 'PLAN_FAILURE'
  | 'PLANNING_RATE_LIMITED'
  // Metrics
  | 'BEHAVIORAL_DIVERSITY_SAMPLE'
  | 'PREDICTION_MAE_SAMPLE'
  | 'GUARDIAN_RESPONSE_LATENCY'
  // Testing
  | 'TEST_STARTED'
  | 'TEST_COMPLETED'
  | 'LESION_ENABLED'
  | 'LESION_DISABLED'
  | 'BASELINE_CAPTURED'
  // System
  | 'SESSION_STARTED'
  | 'SESSION_ENDED'
  | 'SCHEMA_MIGRATION'
  | 'ERROR_RECOVERED'
  // Web
  | 'WS_CLIENT_CONNECTED'
  | 'WS_CLIENT_DISCONNECTED'
  | 'HEALTH_CHECK_COMPLETED'
  | 'CHAT_INPUT_RECEIVED'
  | 'CHAT_RESPONSE_SENT'
  | 'VOICE_TRANSCRIPTION_COMPLETED'
  | 'VOICE_SYNTHESIS_COMPLETED'
  | 'GRAPH_QUERY_EXECUTED'
  | 'METRICS_QUERY_EXECUTED';

// ---------------------------------------------------------------------------
// Event Boundary Map
// ---------------------------------------------------------------------------

/**
 * Compile-time enforcement of event ownership.
 *
 * Each subsystem owns its event types. This map makes boundary violations
 * visible at the type level: if a subsystem is emitting an event it doesn't
 * own, the map is the first place to audit.
 *
 * The map is defined WITHOUT an explicit wide type annotation so that TypeScript
 * infers the literal string types for each value (e.g., 'DECISION_MAKING' rather
 * than SubsystemSource). This enables the ExtractSubsystemEventType conditional
 * type in event-builders.ts to work correctly.
 *
 * The satisfies operator ensures all EventType members are present (compile-time
 * completeness check) while preserving the inferred literal types.
 */
export const EVENT_BOUNDARY_MAP = {
  // Decision Making
  DECISION_CYCLE_STARTED: 'DECISION_MAKING',
  TYPE_1_SELECTED: 'DECISION_MAKING',
  TYPE_2_SELECTED: 'DECISION_MAKING',
  SHRUG_SELECTED: 'DECISION_MAKING',
  ACTION_EXECUTED: 'DECISION_MAKING',
  PREDICTION_CREATED: 'DECISION_MAKING',
  PREDICTION_EVALUATED: 'DECISION_MAKING',
  EPISODE_ENCODED: 'DECISION_MAKING',
  TYPE_1_GRADUATION: 'DECISION_MAKING',
  TYPE_1_DEMOTION: 'DECISION_MAKING',
  TYPE_1_DECISION: 'DECISION_MAKING',
  TYPE_2_DECISION: 'DECISION_MAKING',
  ARBITRATION_COMPLETE: 'DECISION_MAKING',
  // Communication
  INPUT_RECEIVED: 'COMMUNICATION',
  INPUT_PARSED: 'COMMUNICATION',
  RESPONSE_GENERATED: 'COMMUNICATION',
  RESPONSE_DELIVERED: 'COMMUNICATION',
  GUARDIAN_CORRECTION: 'COMMUNICATION',
  GUARDIAN_CONFIRMATION: 'COMMUNICATION',
  SOCIAL_COMMENT_INITIATED: 'COMMUNICATION',
  SOCIAL_CONTINGENCY_MET: 'COMMUNICATION',
  // Learning
  CONSOLIDATION_CYCLE_STARTED: 'LEARNING',
  CONSOLIDATION_CYCLE_COMPLETED: 'LEARNING',
  ENTITY_EXTRACTED: 'LEARNING',
  EDGE_REFINED: 'LEARNING',
  CONTRADICTION_DETECTED: 'LEARNING',
  KNOWLEDGE_RETRIEVAL_AND_USE: 'LEARNING',
  // Drive Engine
  DRIVE_TICK: 'DRIVE_ENGINE',
  DRIVE_RULE_APPLIED: 'DRIVE_ENGINE',
  DRIVE_RELIEF: 'DRIVE_ENGINE',
  SELF_EVALUATION_RUN: 'DRIVE_ENGINE',
  OPPORTUNITY_DETECTED: 'DRIVE_ENGINE',
  RULE_PROPOSED: 'DRIVE_ENGINE',
  PREDICTION_ACCURACY_EVALUATED: 'DRIVE_ENGINE',
  // Planning
  OPPORTUNITY_RECEIVED: 'PLANNING',
  OPPORTUNITY_INTAKE: 'PLANNING',
  OPPORTUNITY_DROPPED: 'PLANNING',
  RESEARCH_COMPLETED: 'PLANNING',
  RESEARCH_INSUFFICIENT: 'PLANNING',
  SIMULATION_COMPLETED: 'PLANNING',
  SIMULATION_NO_VIABLE: 'PLANNING',
  PROPOSAL_GENERATED: 'PLANNING',
  PLAN_PROPOSED: 'PLANNING',
  PLAN_VALIDATED: 'PLANNING',
  PLAN_VALIDATION_FAILED: 'PLANNING',
  PLAN_EVALUATION: 'PLANNING',
  PLAN_CREATED: 'PLANNING',
  PLAN_FAILURE: 'PLANNING',
  PLANNING_RATE_LIMITED: 'PLANNING',
  // Metrics
  BEHAVIORAL_DIVERSITY_SAMPLE: 'DECISION_MAKING',
  PREDICTION_MAE_SAMPLE: 'DECISION_MAKING',
  GUARDIAN_RESPONSE_LATENCY: 'COMMUNICATION',
  // Testing
  TEST_STARTED: 'SYSTEM',
  TEST_COMPLETED: 'SYSTEM',
  LESION_ENABLED: 'SYSTEM',
  LESION_DISABLED: 'SYSTEM',
  BASELINE_CAPTURED: 'SYSTEM',
  // System
  SESSION_STARTED: 'SYSTEM',
  SESSION_ENDED: 'SYSTEM',
  SCHEMA_MIGRATION: 'SYSTEM',
  ERROR_RECOVERED: 'SYSTEM',
  // Web
  WS_CLIENT_CONNECTED: 'WEB',
  WS_CLIENT_DISCONNECTED: 'WEB',
  HEALTH_CHECK_COMPLETED: 'WEB',
  CHAT_INPUT_RECEIVED: 'WEB',
  CHAT_RESPONSE_SENT: 'WEB',
  VOICE_TRANSCRIPTION_COMPLETED: 'WEB',
  VOICE_SYNTHESIS_COMPLETED: 'WEB',
  GRAPH_QUERY_EXECUTED: 'WEB',
  METRICS_QUERY_EXECUTED: 'WEB',
} as const satisfies Record<EventType, SubsystemSource>;

// ---------------------------------------------------------------------------
// Boundary Validation
// ---------------------------------------------------------------------------

/**
 * Validates that an event type matches its declared subsystem source.
 *
 * Returns true if the subsystem is authorized to emit the event type according
 * to EVENT_BOUNDARY_MAP. Returns false if there is a mismatch.
 *
 * Use this function at the boundary where events are created to catch
 * misconfiguration early. The EVENT_BOUNDARY_MAP is the source of truth.
 *
 * @param eventType - The declared event type
 * @param subsystem - The declaring subsystem
 * @returns true if the subsystem owns this event type; false otherwise
 */
export function validateEventBoundary(
  eventType: EventType,
  subsystem: SubsystemSource,
): boolean {
  return EVENT_BOUNDARY_MAP[eventType] === subsystem;
}

/**
 * Reverse mapping from subsystem to its allowed event types.
 *
 * Derived from EVENT_BOUNDARY_MAP to keep the inverse in sync automatically.
 * Use this to enumerate which event types a subsystem is authorized to emit,
 * e.g., for schema validation or type narrowing.
 *
 * Record<SubsystemSource, EventType[]> ensures all subsystems appear at
 * compile time and that the type system keeps this synchronized with the
 * forward map above.
 */
export const EVENT_TYPE_BOUNDARIES: Readonly<
  Record<SubsystemSource, readonly EventType[]>
> = (() => {
  const boundaries: Record<SubsystemSource, EventType[]> = {
    DECISION_MAKING: [],
    COMMUNICATION: [],
    LEARNING: [],
    DRIVE_ENGINE: [],
    PLANNING: [],
    SYSTEM: [],
    WEB: [],
  };

  // Populate by iterating the forward map
  for (const [eventType, subsystem] of Object.entries(EVENT_BOUNDARY_MAP)) {
    boundaries[subsystem as SubsystemSource].push(eventType as EventType);
  }

  return boundaries as Readonly<Record<SubsystemSource, readonly EventType[]>>;
})();

// ---------------------------------------------------------------------------
// Base Event Interface
// ---------------------------------------------------------------------------

/**
 * Base interface for every event persisted to TimescaleDB.
 *
 * All subsystem-specific event types extend this interface. The driveSnapshot
 * is required because the theater validator and drive correlations downstream
 * need to know what Sylphie's motivational state was at the moment of the event.
 *
 * schemaVersion: Monotonically increasing integer. Increment when the shape of
 * a specific event subtype changes. Consumers can reject events with unknown
 * versions rather than silently misinterpret them.
 */
export interface SylphieEvent {
  /** UUID v4. Unique per event record. */
  readonly id: string;

  /** The type of this event. Always one of the centralized EventType values. */
  readonly type: EventType;

  /** Wall-clock time the event was created (not persisted). */
  readonly timestamp: Date;

  /** Which subsystem emitted this event. Must match EVENT_BOUNDARY_MAP[type]. */
  readonly subsystem: SubsystemSource;

  /** Session identifier for correlating events across a single interaction session. */
  readonly sessionId: string;

  /**
   * Drive state at the moment this event was created.
   *
   * Required on all events. The Theater Prohibition (CANON Standard 1) requires
   * correlating output with actual drive state; having the snapshot on every event
   * makes retrospective analysis possible without additional queries.
   */
  readonly driveSnapshot: DriveSnapshot;

  /** Schema version for forward-compatibility. Consumers reject unknown versions. */
  readonly schemaVersion: number;

  /**
   * Optional correlation ID for tracing causal chains across multiple events.
   * E.g., the INPUT_RECEIVED event ID flows through to RESPONSE_DELIVERED so
   * the full processing pipeline can be reconstructed from the event log.
   */
  readonly correlationId?: string;

  /**
   * Optional provenance source indicating where the information in this event originated.
   * Used for tracking trust and validity of content that flows into learning or
   * decision-making. Distinct from subsystem ownership (which comes from EVENT_BOUNDARY_MAP).
   *
   * E.g., an INPUT_RECEIVED event might have provenance = 'SENSOR' (from STT),
   * while a GUARDIAN_CORRECTION event might have provenance = 'GUARDIAN'.
   */
  readonly provenance?: ProvenanceSource;
}

// ---------------------------------------------------------------------------
// Learnable Events
// ---------------------------------------------------------------------------

/**
 * Feedback type attached by the guardian during a Communication event.
 * Carried on LearnableEvent so the Learning subsystem can weight accordingly.
 *
 * CANON Immutable Standard 5 (Guardian Asymmetry): confirmation = 2x, correction = 3x.
 */
export type GuardianFeedbackType = 'confirmation' | 'correction' | 'none';

/**
 * Event subtype for events that the Learning subsystem should process.
 *
 * Extends SylphieEvent with fields that the consolidation pipeline uses to
 * decide what to learn and how to weight it. Only Communication events
 * with actionable content should have hasLearnable = true.
 *
 * CANON §Subsystem 3 (Learning): max 5 learnable events per cycle to prevent
 * catastrophic interference. The salience field is used for prioritization when
 * the cycle budget is limited.
 */
export interface LearnableEvent extends SylphieEvent {
  /**
   * True if this event contains content the Learning subsystem should process.
   * Gating flag — the Learning subsystem queries for `has_learnable = true`.
   */
  readonly hasLearnable: boolean;

  /**
   * The raw content to be learned (typically the conversation turn or observed fact).
   * Only meaningful when hasLearnable is true.
   */
  readonly content: string;

  /**
   * Guardian feedback attached to this event, if any.
   * Drives weighting in consolidation (Standard 5).
   */
  readonly guardianFeedbackType: GuardianFeedbackType;

  /**
   * The provenance source of the content.
   * Determines base confidence for any WKG nodes created from this event.
   */
  readonly source: 'SENSOR' | 'GUARDIAN' | 'LLM_GENERATED';

  /**
   * Salience score in [0.0, 1.0]. Higher values are prioritized when the
   * Learning cycle budget (max 5) forces selection. Derived from drive state,
   * prediction error, and guardian feedback presence.
   */
  readonly salience: number;
}

// ---------------------------------------------------------------------------
// Reinforcement Events
// ---------------------------------------------------------------------------

/**
 * Base interface for all reinforcement events.
 *
 * CANON Immutable Standard 2 (Contingency Requirement): Every positive
 * reinforcement event must trace to a specific behavior. The actionId field
 * is REQUIRED — it is the structural enforcement of the Contingency Requirement.
 * Without an actionId, the Drive Engine cannot attribute drive relief to a
 * specific behavior, and the learning signal is invalid.
 */
export interface ReinforcementEvent extends SylphieEvent {
  /**
   * The ID of the action that produced this reinforcement.
   * REQUIRED. Null is not permitted. The Contingency Requirement demands a
   * specific behavior trace for every reinforcement signal.
   */
  readonly actionId: string;

  /**
   * Whether the reinforcement was positive (drive relief) or negative (drive pressure).
   * Used by the Drive Engine to select the correct behavioral contingency.
   */
  readonly reinforcementPolarity: 'positive' | 'negative';
}

/**
 * Guardian confirmation event — carries both reinforcement semantics and learnable flag.
 *
 * Emitted by Communication when the guardian explicitly confirms Sylphie's behavior.
 * The 2x guardian weight (Standard 5) is applied by the Drive Engine when it
 * processes this event via the IPC channel.
 */
export interface GuardianConfirmationEvent extends ReinforcementEvent, LearnableEvent {
  readonly type: 'GUARDIAN_CONFIRMATION';
  readonly subsystem: 'COMMUNICATION';
}

/**
 * Guardian correction event — carries both reinforcement and learnable flag.
 *
 * Emitted by Communication when the guardian corrects Sylphie.
 * The 3x correction weight (Standard 5) is applied by the Drive Engine.
 * This event should always be learnable (hasLearnable = true) — corrections
 * are high-salience learning signals.
 */
export interface GuardianCorrectionEvent extends ReinforcementEvent, LearnableEvent {
  readonly type: 'GUARDIAN_CORRECTION';
  readonly subsystem: 'COMMUNICATION';
}

/**
 * Action executed event — records what was executed and serves as the anchor
 * for all downstream reinforcement attribution.
 */
export interface ActionExecutedEvent extends SylphieEvent {
  readonly type: 'ACTION_EXECUTED';
  readonly subsystem: 'DECISION_MAKING';
  /** The ID of the action procedure that was executed. */
  readonly actionId: string;
  /** The type name of the action (for diversity tracking). */
  readonly actionType: string;
  /** Which arbitration path produced this action. */
  readonly arbitrationType: 'TYPE_1' | 'TYPE_2';
}

/**
 * Prediction evaluated event — records prediction accuracy for a single prediction.
 * Used by Drive Engine for Type 1/2 graduation logic and opportunity detection.
 */
export interface PredictionEvaluatedEvent extends SylphieEvent {
  readonly type: 'PREDICTION_EVALUATED';
  readonly subsystem: 'DECISION_MAKING';
  /** The ID of the prediction being evaluated. */
  readonly predictionId: string;
  /** The ID of the action the prediction was made for. */
  readonly actionId: string;
  /** Absolute error for this single prediction in [0.0, 1.0]. */
  readonly absoluteError: number;
  /** Whether the prediction was considered accurate (error < graduation MAE threshold). */
  readonly accurate: boolean;
}

/**
 * TYPE_1_DECISION event — emitted when a Type 1 action is confirmed for execution.
 *
 * Carries the structured payload required by Observatory developmental-stage and
 * comprehension-accuracy endpoints. Distinct from TYPE_1_SELECTED: this event
 * is emitted after the arbitration winner is resolved, with full action context.
 */
export interface Type1DecisionEvent extends SylphieEvent {
  readonly type: 'TYPE_1_DECISION';
  readonly subsystem: 'DECISION_MAKING';
  /** Human-readable action category name (e.g., 'ConversationalResponse'). */
  readonly actionType: string;
  /** ACT-R confidence of the selected candidate at arbitration time. */
  readonly confidence: number;
  /** Optional context fingerprint for pattern correlation queries. */
  readonly contextFingerprint?: string;
}

/**
 * TYPE_2_DECISION event — emitted when a Type 2 LLM-assisted action is confirmed.
 *
 * Carries the LLM latency in addition to action context. The llmLatencyMs field
 * is load-bearing for Type 2 cost accounting (CANON §Type 2 must carry explicit cost).
 */
export interface Type2DecisionEvent extends SylphieEvent {
  readonly type: 'TYPE_2_DECISION';
  readonly subsystem: 'DECISION_MAKING';
  /** Human-readable action category name. */
  readonly actionType: string;
  /** Confidence of the selected candidate. For novel Type 2 this may be 0.0. */
  readonly confidence: number;
  /** Wall-clock latency of the LLM call in milliseconds. */
  readonly llmLatencyMs: number;
  /** Optional context fingerprint for pattern correlation queries. */
  readonly contextFingerprint?: string;
}

/**
 * ARBITRATION_COMPLETE event — emitted once per arbitration cycle summarising the outcome.
 *
 * Consumed by the Observatory to compute:
 *   - Developmental stage (Type 1 ratio over rolling window)
 *   - Comprehension accuracy (threshold vs. candidate confidence spread)
 *
 * Emitted for TYPE_1, TYPE_2, and SHRUG outcomes. For SHRUG, both type1Confidence
 * and type2Confidence reflect the best available candidate values (may be 0 if no
 * candidates existed).
 */
export interface ArbitrationCompleteEvent extends SylphieEvent {
  readonly type: 'ARBITRATION_COMPLETE';
  readonly subsystem: 'DECISION_MAKING';
  /** Which process won arbitration. */
  readonly winner: 'type1' | 'type2' | 'shrug';
  /** Confidence of the best Type 1 candidate, or 0 if none existed. */
  readonly type1Confidence: number;
  /** Confidence of the best Type 2 candidate, or 0 if none existed. */
  readonly type2Confidence: number;
  /** The dynamic threshold value that candidates were measured against. */
  readonly dynamicThreshold: number;
}

// ---------------------------------------------------------------------------
// Web Event Payloads
// ---------------------------------------------------------------------------

/**
 * Payload for WS_CLIENT_CONNECTED event.
 * Emitted when a WebSocket client establishes a connection.
 */
export interface WsClientConnectedPayload {
  readonly channel: string;
  readonly clientId: string;
}

/**
 * Payload for WS_CLIENT_DISCONNECTED event.
 * Emitted when a WebSocket client disconnects from the server.
 */
export interface WsClientDisconnectedPayload {
  readonly channel: string;
  readonly clientId: string;
  readonly durationMs: number;
}

/**
 * Payload for HEALTH_CHECK_COMPLETED event.
 * Records the result of a system health check cycle including database statuses.
 */
export interface HealthCheckCompletedPayload {
  readonly status: 'healthy' | 'degraded' | 'unhealthy';
  readonly databases: Record<string, { readonly status: string; readonly latencyMs: number }>;
}

/**
 * Payload for CHAT_INPUT_RECEIVED event.
 * Records when user input arrives via the chat interface.
 */
export interface ChatInputReceivedPayload {
  readonly sessionId: string;
  readonly inputLength: number;
}

/**
 * Payload for CHAT_RESPONSE_SENT event.
 * Records when a response is sent back to the chat client.
 */
export interface ChatResponseSentPayload {
  readonly sessionId: string;
  readonly responseLength: number;
  readonly latencyMs: number;
  readonly theaterPassed: boolean;
}

/**
 * Payload for VOICE_TRANSCRIPTION_COMPLETED event.
 * Records the completion of voice-to-text transcription.
 */
export interface VoiceTranscriptionCompletedPayload {
  readonly latencyMs: number;
  readonly textLength: number;
  readonly confidence: number;
}

/**
 * Payload for VOICE_SYNTHESIS_COMPLETED event.
 * Records the completion of text-to-speech synthesis.
 */
export interface VoiceSynthesisCompletedPayload {
  readonly latencyMs: number;
  readonly audioLengthMs: number;
}

/**
 * Payload for GRAPH_QUERY_EXECUTED event.
 * Records the execution of a knowledge graph query.
 */
export interface GraphQueryExecutedPayload {
  readonly queryType: 'snapshot' | 'stats' | 'subgraph';
  readonly nodeCount: number;
  readonly latencyMs: number;
}

/**
 * Payload for METRICS_QUERY_EXECUTED event.
 * Records the execution of a system metrics query.
 */
export interface MetricsQueryExecutedPayload {
  readonly metricsRequested: readonly string[];
  readonly latencyMs: number;
}
