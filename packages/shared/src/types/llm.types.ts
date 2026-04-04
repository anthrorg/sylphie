/**
 * LLM interface types: requests, responses, context, and the ILlmService contract.
 *
 * CANON §Architecture: The LLM is Sylphie's voice, not her mind.
 * CANON §Dual-Process Cognition: Type 2 deliberation is LLM-assisted and must
 * always carry an explicit cost (latency + cognitive effort pressure + compute budget).
 *
 * Location rationale (CANON subsystem boundary fix, E0-T010 note):
 * This file lives in src/shared/types, NOT in src/communication. The LLM is used
 * by three subsystems (Communication for response generation, Learning for edge
 * refinement, Planning for constraint validation). If the interface lived in
 * Communication, Learning and Planning would have a cross-subsystem import,
 * violating module boundaries. Shared placement allows all three to import without
 * coupling to each other.
 *
 * The concrete implementation (AnthropicLlmService) lives in src/communication
 * and provides the LLM_SERVICE token. The interface is shared; the wiring is not.
 */

import type { DriveSnapshot } from './drive.types';

// ---------------------------------------------------------------------------
// LLM Service Token
// ---------------------------------------------------------------------------

/**
 * DI injection token for the LLM service.
 *
 * Symbol token prevents name collisions. Subsystems inject ILlmService via
 * @Inject(LLM_SERVICE) rather than directly depending on the concrete class.
 *
 * The concrete implementation (AnthropicLlmService) is registered by
 * CommunicationModule. Other modules declare LLM_SERVICE as an import.
 */
export const LLM_SERVICE = Symbol('LLM_SERVICE');

// ---------------------------------------------------------------------------
// LLM Request and Response
// ---------------------------------------------------------------------------

/**
 * A single message in an LLM conversation turn.
 */
export interface LlmMessage {
  /** Conversation role. Anthropic API convention. */
  readonly role: 'user' | 'assistant';

  /** Text content of this message. */
  readonly content: string;
}

/**
 * Request payload for an LLM API call.
 *
 * Encapsulates everything the LLM needs to generate a response. The systemPrompt
 * is separate from messages to align with Anthropic's API conventions.
 *
 * CANON §Communication: Drive state must be injected into LLM context when
 * generating responses. The metadata field carries drive context through to
 * the theater validator.
 */
export interface LlmRequest {
  /**
   * Ordered conversation messages (alternating user/assistant turns).
   * The last message is always 'user' role.
   */
  readonly messages: readonly LlmMessage[];

  /**
   * System prompt establishing Sylphie's persona and context for this call.
   * Assembled by the calling subsystem from WKG context, drive state, and
   * conversation history. Not part of the messages array per Anthropic API.
   */
  readonly systemPrompt: string;

  /**
   * Maximum tokens for the completion.
   * Type 2 deliberation budget is config-controlled (AppConfig.llm.maxTokensType2).
   * Learning refinement and Planning validation typically use smaller budgets.
   */
  readonly maxTokens: number;

  /**
   * Temperature for sampling. Range [0.0, 1.0].
   * Planning constraint validation: 0.0–0.2 (deterministic).
   * Communication response generation: 0.6–0.9 (expressive).
   * Learning refinement: 0.2–0.4 (conservative).
   */
  readonly temperature: number;

  /**
   * Caller-supplied metadata for cost attribution and theater validation.
   * At minimum, callers should include the subsystem and call purpose.
   */
  readonly metadata: LlmCallMetadata;
}

/**
 * Metadata attached to every LLM request for attribution and monitoring.
 */
export interface LlmCallMetadata {
  /**
   * Which subsystem is making this call.
   * Used to attribute token costs to the correct drive pressure calculation.
   */
  readonly callerSubsystem: 'COMMUNICATION' | 'LEARNING' | 'PLANNING';

  /**
   * Human-readable purpose of this call.
   * Example: 'TYPE_2_DELIBERATION', 'EDGE_REFINEMENT', 'PLAN_CONSTRAINT_VALIDATION'
   */
  readonly purpose: string;

  /**
   * The session ID, for correlating LLM calls with TimescaleDB events.
   */
  readonly sessionId: string;

  /**
   * Optional: the correlation ID of the event that triggered this LLM call.
   * Enables end-to-end tracing from input event to LLM response.
   */
  readonly correlationId?: string;
}

/**
 * Response from a completed LLM API call.
 *
 * tokensUsed is broken out into prompt and completion for precise cognitive
 * effort pressure calculation. The Drive Engine applies different weights
 * to prompt vs completion tokens in its cost model.
 *
 * cost is an estimate at the time of the call based on the model's pricing.
 * Used for monitoring and future budget controls. NOT used for drive pressure
 * (that uses tokensUsed directly).
 */
export interface LlmResponse {
  /**
   * The LLM's generated text response.
   * The theater validator must check this against the drive state before use.
   */
  readonly content: string;

  /** Token usage breakdown for precise cost and effort attribution. */
  readonly tokensUsed: {
    /** Tokens in the input (system prompt + messages). */
    readonly prompt: number;
    /** Tokens in the generated completion. */
    readonly completion: number;
  };

  /**
   * End-to-end latency in milliseconds (from request dispatch to response received).
   * Reported to the Drive Engine as part of SoftwareMetricsPayload to compute
   * cognitive effort pressure.
   */
  readonly latencyMs: number;

  /**
   * The model identifier that generated this response.
   * Example: 'claude-opus-4-5', 'claude-sonnet-4-6'
   * Used for monitoring model drift and cost tracking.
   */
  readonly model: string;

  /**
   * Estimated USD cost of this API call.
   * Computed from tokensUsed and current model pricing at call time.
   * Rounded to 6 decimal places.
   */
  readonly cost: number;
}

// ---------------------------------------------------------------------------
// LLM Context Assembly
// ---------------------------------------------------------------------------

/**
 * A recent episode from episodic memory, included in LLM context.
 *
 * Structurally minimal here — the full EpisodicMemory types are defined in
 * decision-making. LlmContext carries only what the LLM needs, not the full
 * TimescaleDB record.
 */
export interface EpisodeSummary {
  /** Brief description of what happened in this episode. */
  readonly summary: string;

  /** Wall-clock time of the episode. Used to give the LLM temporal context. */
  readonly timestamp: Date;

  /**
   * Age-based weight for this episode in [0.0, 1.0].
   * Recent episodes = 1.0. Older episodes degrade. The LLM context assembler
   * uses this to decide whether to include or truncate aged episodes.
   */
  readonly ageWeight: number;
}

/**
 * WKG context retrieved for a specific query, passed to the LLM as grounding.
 *
 * The LLM should not invent facts about entities that have WKG nodes —
 * wkgContext provides the current ground truth from the graph.
 */
export interface WkgContextEntry {
  /** The entity label. */
  readonly label: string;
  /** Known properties from the WKG. */
  readonly properties: Record<string, unknown>;
  /** Confidence of the most relevant node for this entity. */
  readonly confidence: number;
}

/**
 * Simplified person model extracted from the Other KG, passed to the LLM
 * for person-aware response generation.
 */
export interface PersonModelSummary {
  /** Person identifier (e.g., 'Person_Jim'). */
  readonly personId: string;
  /** Known facts about this person relevant to the current context. */
  readonly knownFacts: readonly string[];
  /** Interaction history summary (e.g., "typically asks about X, prefers Y responses"). */
  readonly interactionSummary: string;
}

/**
 * All context assembled for an LLM call.
 *
 * CANON §Communication: Drive state must be injected into LLM context. The
 * driveSnapshot field is required — the LLM speaks for Sylphie and must know
 * how she is feeling to speak authentically (Theater Prohibition, Standard 1).
 *
 * Context assembly is the responsibility of the calling subsystem. This type
 * defines what MUST be present; callers may omit optional fields when not relevant.
 */
export interface LlmContext {
  /**
   * Drive state at context assembly time.
   * REQUIRED. The Theater Prohibition validator needs this to check whether
   * the LLM's output correlates with Sylphie's actual state.
   */
  readonly driveSnapshot: DriveSnapshot;

  /**
   * Recent episodes from episodic memory, in reverse chronological order.
   * Provides temporal grounding. The assembler includes episodes with ageWeight > 0.3.
   */
  readonly recentEpisodes: readonly EpisodeSummary[];

  /**
   * Relevant WKG context for entities mentioned in the current input.
   * Prevents LLM hallucination about known entities.
   */
  readonly wkgContext: readonly WkgContextEntry[];

  /**
   * Person model for the guardian or other interlocutor, if available.
   * Enables person-aware response calibration.
   */
  readonly personModel: PersonModelSummary | null;

  /**
   * Recent conversation history (alternating turns), for conversational coherence.
   * Capped at a configurable window size to stay within token budget.
   */
  readonly conversationHistory: readonly LlmMessage[];
}

// ---------------------------------------------------------------------------
// Type 2 Cost Estimation
// ---------------------------------------------------------------------------

/**
 * Pre-call cost estimate for a Type 2 deliberation request.
 *
 * CANON §Dual-Process Cognition: Type 2 must always carry an explicit cost.
 * Before invoking the LLM, the system estimates cost to:
 * 1. Apply pre-emptive cognitive effort pressure to the CognitiveAwareness drive.
 * 2. Decide whether the budget allows this call (budget draw-down check).
 * 3. Log that Type 2 was invoked even if the call is abandoned.
 *
 * This estimate is computed from request content BEFORE the API call.
 */
export interface Type2CostEstimate {
  /**
   * Estimated total tokens (prompt + completion) for this call.
   * Computed from actual prompt token count + (maxTokens * utilization estimate).
   */
  readonly tokenEstimate: number;

  /**
   * Estimated latency in milliseconds based on model and token estimate.
   * Model-specific P50 latency estimate — not a guarantee.
   */
  readonly latencyEstimate: number;

  /**
   * Pre-computed cognitive effort pressure to apply to the CognitiveAwareness drive
   * before the call executes. This is the "upfront cost" that creates evolutionary
   * pressure toward Type 1 graduation.
   *
   * Formula: proportional to tokenEstimate and latencyEstimate, bounded by
   * the Drive Engine's cognitive effort rate configured in AppConfig.
   * Value in [0.0, 1.0] — added directly to CognitiveAwareness pressure.
   */
  readonly cognitiveEffortCost: number;
}

// ---------------------------------------------------------------------------
// ILlmService Interface
// ---------------------------------------------------------------------------

/**
 * Interface for the LLM service.
 *
 * Three subsystems inject this interface (Communication, Learning, Planning).
 * The concrete implementation lives in CommunicationModule and is registered
 * under the LLM_SERVICE token.
 *
 * isAvailable() is required for Lesion Test support (CANON §The Lesion Test):
 * Periodically run Sylphie without LLM access to observe Type 1 coverage.
 * The Lesion Test sets the service unavailable; all callers must handle false
 * gracefully by falling back to SHRUG or cached responses.
 */
export interface ILlmService {
  /**
   * Execute an LLM API call and return the response.
   *
   * Callers MUST report the returned latencyMs and tokensUsed to the Drive
   * Engine via SoftwareMetricsPayload after this call returns. Failing to
   * report is a Theater violation — cognitive effort was spent but not recorded.
   *
   * @param request - The fully assembled LLM request including context.
   * @returns The LLM response with token usage and latency.
   * @throws LlmUnavailableError if isAvailable() returns false.
   * @throws LlmRateLimitError if the API rate limit was hit.
   * @throws LlmTimeoutError if the call exceeded the configured timeout.
   */
  complete(request: LlmRequest): Promise<LlmResponse>;

  /**
   * Estimate the cost of an LLM call before making it.
   *
   * Used by the Arbitrator to apply pre-emptive cognitive effort pressure
   * and verify budget availability before committing to a Type 2 deliberation.
   *
   * This method must not make an API call — it is a pure estimation from
   * the request content.
   *
   * @param request - The request to estimate cost for.
   * @returns Cost estimate with token count, latency, and cognitive effort cost.
   */
  estimateCost(request: LlmRequest): Type2CostEstimate;

  /**
   * Whether the LLM service is currently available.
   *
   * Returns false when:
   * - The Lesion Test is active (guardian triggered test mode).
   * - API key is not configured.
   * - Circuit breaker has tripped after repeated failures.
   * - Budget limit has been reached.
   *
   * When false, callers must fall back gracefully:
   * - Decision Making: SHRUG if no Type 1 candidate.
   * - Learning: skip LLM-assisted refinement for this cycle.
   * - Planning: defer plan validation until service is restored.
   *
   * @returns True if the service can accept calls; false otherwise.
   */
  isAvailable(): boolean;
}
