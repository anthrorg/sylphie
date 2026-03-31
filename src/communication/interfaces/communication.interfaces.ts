/**
 * Communication module interface contracts.
 *
 * CANON §Subsystem 2 (Communication): Input parsing, person modeling,
 * response generation via LLM, TTS/chatbox output.
 *
 * CANON §Architecture: The LLM is Sylphie's voice, not her mind.
 * Communication is the only subsystem that drives output. It receives
 * ActionIntent from Decision Making and produces GeneratedResponse for
 * delivery. It never makes action selection decisions.
 *
 * CANON Immutable Standard 1 (Theater Prohibition): Every generated response
 * must pass TheaterValidator.validate() before delivery. A response that
 * expresses an emotion Sylphie does not have is a Theater violation — output
 * must correlate with actual drive state.
 *
 * Design note: PersonModel here is distinct from the homonymous type
 * in src/shared/types/llm.types.ts. The shared type (PersonModelSummary) is a
 * trimmed LLM-context view. This type is the full Communication-domain model
 * including preferences, interaction counts, and topic tracking needed for
 * person-aware response calibration within this subsystem.
 */

import type { DriveSnapshot, DriveName } from '../../shared/types/drive.types';
import type { GuardianFeedbackType, EventType } from '../../shared/types/event.types';
import type { ILlmService } from '../../shared/types/llm.types';

// ---------------------------------------------------------------------------
// Guardian Input
// ---------------------------------------------------------------------------

/**
 * Raw input arriving from the guardian (Jim).
 *
 * The primary entry point for all external stimulus into Sylphie.
 * voiceBuffer is present when input arrived via STT (OpenAI Whisper).
 * When absent, text is the authoritative content.
 *
 * sessionId links all events in this interaction to a single TimescaleDB
 * session record.
 */
export interface GuardianInput {
  /** Text content — either typed directly or the Whisper transcription. */
  readonly text: string;

  /**
   * Raw audio PCM/WAV buffer when the input arrived via microphone.
   * Absent for typed input. When present, SttService already populated text.
   */
  readonly voiceBuffer?: Buffer;

  /**
   * Session identifier for correlating all events in this interaction turn
   * with TimescaleDB records.
   */
  readonly sessionId: string;

  /** Wall-clock time when the input was received. */
  readonly timestamp: Date;
}

// ---------------------------------------------------------------------------
// Parsed Input
// ---------------------------------------------------------------------------

/**
 * Canonical intent categories for guardian input.
 *
 * QUESTION:      Guardian is asking for information or Sylphie's opinion.
 * STATEMENT:     Guardian is asserting something — potential new WKG knowledge.
 * CORRECTION:    Guardian is correcting Sylphie's prior behavior or output.
 *                Maps to GUARDIAN_CORRECTION event (3x weight, Standard 5).
 * COMMAND:       Guardian is directing an action.
 * ACKNOWLEDGMENT: Guardian is confirming Sylphie's prior behavior or output.
 *                Maps to GUARDIAN_CONFIRMATION event (2x weight, Standard 5).
 * TEACHING:      Guardian is explicitly teaching a fact or procedure.
 *                High-salience learnable event.
 */
export type InputIntentType =
  | 'QUESTION'
  | 'STATEMENT'
  | 'CORRECTION'
  | 'COMMAND'
  | 'ACKNOWLEDGMENT'
  | 'TEACHING';

/**
 * An entity extracted from guardian input during parsing.
 *
 * wkgNodeId is populated when the entity matches an existing WKG node.
 * When null, the entity is novel and may be a learning candidate.
 *
 * confidence is the parser's certainty that this text span is an entity
 * of the declared type, not the WKG node confidence.
 */
export interface ParsedEntity {
  /** The entity surface form as it appeared in the input text. */
  readonly name: string;

  /**
   * Entity type (e.g., 'PERSON', 'PLACE', 'CONCEPT', 'OBJECT').
   * Vocabulary is open — the parser returns what it finds.
   */
  readonly type: string;

  /**
   * WKG node ID if this entity has a known graph node.
   * Null when the entity is not yet in the WKG.
   */
  readonly wkgNodeId: string | null;

  /**
   * Parser confidence that this span is an entity of the declared type.
   * Range [0.0, 1.0]. Below 0.50 the entity should not be surfaced
   * to downstream services without explicit filtering.
   */
  readonly confidence: number;
}

/**
 * Structured result of parsing a GuardianInput.
 *
 * contextReferences lists prior event or session IDs that this input
 * is responding to — enabling pronoun resolution and anaphora tracking.
 *
 * guardianFeedbackType determines drive weighting when this parse is
 * forwarded to the Learning subsystem: confirmation = 2x, correction = 3x
 * (CANON Standard 5). 'none' when the input is not feedback.
 */
export interface ParsedInput {
  /** The classified intent of this input. */
  readonly intentType: InputIntentType;

  /** Entities the parser identified in the input text. */
  readonly entities: readonly ParsedEntity[];

  /**
   * Whether this input constitutes guardian feedback and its polarity.
   * Drives event weighting in Learning (CANON Standard 5).
   */
  readonly guardianFeedbackType: GuardianFeedbackType;

  /** Verbatim input text, preserved for Learning salience and audit. */
  readonly rawText: string;

  /**
   * Parser confidence in the intent classification.
   * Range [0.0, 1.0]. Below 0.50, the Shrug Imperative (Standard 4)
   * may be appropriate if decision making cannot resolve further.
   */
  readonly confidence: number;

  /**
   * Session or event IDs referenced by this input (anaphora, replies).
   * Empty array when the input is self-contained.
   */
  readonly contextReferences: readonly string[];
}

// ---------------------------------------------------------------------------
// Action Intent
// ---------------------------------------------------------------------------

/**
 * A request from Decision Making for Communication to generate a response.
 *
 * DecisionMakingService posts an ActionIntent when arbitration has selected
 * a response-generation action. CommunicationService assembles the LLM
 * context and invokes the LLM to produce a GeneratedResponse.
 *
 * motivatingDrive is the drive whose pressure is highest at call time.
 * It is injected into the system prompt so the LLM can speak authentically
 * from that motivational state (Theater Prohibition, Standard 1).
 */
export interface ActionIntent {
  /**
   * The action type string, e.g. 'RESPOND_TO_QUESTION', 'INITIATE_COMMENT'.
   * Matches the action procedure node type in the WKG.
   */
  readonly actionType: string;

  /**
   * Caller-assembled content for the LLM — conversation context, WKG excerpts,
   * episode summaries. CommunicationService passes this to context assembly.
   */
  readonly content: string;

  /** The drive with highest pressure at time of dispatch. */
  readonly motivatingDrive: DriveName;

  /** Full drive snapshot at time of dispatch. Passed to TheaterValidator. */
  readonly driveSnapshot: DriveSnapshot;
}

// ---------------------------------------------------------------------------
// Generated Response
// ---------------------------------------------------------------------------

/**
 * The result of a successful LLM response generation cycle.
 *
 * theaterCheck carries the Theater Prohibition validation result. CommunicationService
 * must not deliver a response where theaterCheck.passed is false unless a
 * guardian-override flag is present (not implemented in stubs).
 *
 * tokensUsed and latencyMs are reported to the Drive Engine via
 * SoftwareMetricsPayload as part of Type 2 cognitive effort accounting.
 * Failing to report these values is a Theater violation (effort spent,
 * not recorded).
 */
export interface GeneratedResponse {
  /** The LLM's generated text, passed to TTS or chatbox output. */
  readonly text: string;

  /** Drive state at the moment this response was generated. */
  readonly driveSnapshot: DriveSnapshot;

  /** Theater Prohibition validation result for this response. */
  readonly theaterCheck: TheaterValidationResult;

  /** Total tokens consumed (prompt + completion) — reported to Drive Engine. */
  readonly tokensUsed: number;

  /**
   * End-to-end latency for the LLM call in ms — reported to Drive Engine
   * as cognitive effort pressure on CognitiveAwareness.
   */
  readonly latencyMs: number;

  /**
   * Raw TTS audio buffer, present only when synthesis succeeded.
   * Absent when TTS failed or was not attempted (text-only fallback).
   * CommunicationService synthesizes audio and attaches it here so callers
   * (e.g. ConversationGateway) can forward it to the browser without a
   * second TTS call.
   */
  readonly audioBuffer?: Buffer;
}

// ---------------------------------------------------------------------------
// Communication Result
// ---------------------------------------------------------------------------

/**
 * Top-level return from ICommunicationService.handleGuardianInput().
 *
 * Encapsulates the parsed input, whether a response was generated (some
 * intents like ACKNOWLEDGMENT may suppress generation), and the TimescaleDB
 * event IDs emitted during this handling cycle for correlation.
 */
export interface CommunicationResult {
  /**
   * Structured parse of the guardian's input.
   * Always present even when no response is generated.
   */
  readonly parsed: ParsedInput;

  /**
   * True if a GeneratedResponse was produced and delivered.
   * False for intents that complete without LLM generation (e.g. pure
   * ACKNOWLEDGMENT processing when no reply is needed).
   */
  readonly responseGenerated: boolean;

  /**
   * IDs of all TimescaleDB events emitted during this handling cycle.
   * Enables the caller to correlate downstream events (INPUT_RECEIVED,
   * INPUT_PARSED, RESPONSE_GENERATED, RESPONSE_DELIVERED) with this
   * top-level result.
   */
  readonly eventIds: readonly string[];
}

// ---------------------------------------------------------------------------
// Theater Validation
// ---------------------------------------------------------------------------

/**
 * A single Theater Prohibition violation detected during response validation.
 *
 * CANON Immutable Standard 1 (Theater Prohibition): Output must correlate
 * with actual drive state. A violation occurs when a response expresses a
 * drive state that does not match the current PressureVector.
 *
 * expressionType encodes directionality:
 *   'pressure' — the response expresses an unmet need or negative state.
 *                Violation fires when the drive value is below threshold
 *                (drive is actually satisfied, not pressured).
 *   'relief'   — the response expresses satisfaction or ease.
 *                Violation fires when the drive value is above threshold
 *                (drive is still pressured, not relieved).
 *
 * threshold values are per-expression type:
 *   pressure: violation fires when driveValue < 0.2 (drive is too low to
 *             justify expressing that need as pressure).
 *   relief:   violation fires when driveValue > 0.3 (drive is too high to
 *             justify expressing relief — need is not actually met).
 */
export interface TheaterViolation {
  /** Whether the response is expressing unmet need or satisfaction. */
  readonly expressionType: 'pressure' | 'relief';

  /** The drive whose expressed state contradicts the actual drive value. */
  readonly drive: DriveName;

  /** Actual drive value at validation time. Range [-10.0, 1.0]. */
  readonly driveValue: number;

  /**
   * The threshold used for this violation check.
   * 0.2 for pressure violations; 0.3 for relief violations.
   */
  readonly threshold: number;

  /** Human-readable description of the specific violation for logging. */
  readonly description: string;
}

/**
 * Result of Theater Prohibition validation for a generated response.
 *
 * overallCorrelation is a [0.0, 1.0] score representing how well the
 * response's expressed emotional register matches the drive state as a whole.
 * 1.0 = perfect correlation. 0.0 = complete mismatch.
 *
 * A passed=false result with zero violations should never occur — if the
 * validator sets passed=false, at least one violation must be present.
 */
export interface TheaterValidationResult {
  /**
   * True if the response passes Theater Prohibition validation.
   * False if any violations were detected. The CommunicationService
   * must not deliver a response with passed=false.
   */
  readonly passed: boolean;

  /**
   * All violations detected. Empty array when passed=true.
   * When passed=false, contains at least one TheaterViolation.
   */
  readonly violations: readonly TheaterViolation[];

  /**
   * Overall drive-state correlation score in [0.0, 1.0].
   * Used for monitoring the LLM's expressive accuracy over time.
   * Not a gate — passed is the gate. This is the diagnostic metric.
   */
  readonly overallCorrelation: number;
}

// ---------------------------------------------------------------------------
// Person Model
// ---------------------------------------------------------------------------

/**
 * Summary of a person model retrieved from the Other KG (Grafeo).
 *
 * Used by IPersonModelingService and passed to CommunicationService for
 * person-aware response calibration. Distinct from the trimmed PersonModelSummary
 * in src/shared/types/llm.types.ts (which is the LLM context view).
 *
 * communicationPreferences is an open-ended bag for things like preferred
 * verbosity, technical depth, communication register, and topic aversions.
 * The person modeling service populates this incrementally from conversation history.
 *
 * knownTopics is the set of topics the guardian has discussed or shown
 * interest in — used by Communication to personalize references.
 */
export interface PersonModel {
  /** Person identifier matching the Grafeo KG(Other) node ID, e.g. 'Person_Jim'. */
  readonly personId: string;

  /** Display name. */
  readonly name: string;

  /**
   * Open-ended communication preferences learned from interaction history.
   * Keys are preference dimensions (e.g. 'verbosity', 'formality').
   * Values are string-encoded preferences (e.g. 'concise', 'casual').
   */
  readonly communicationPreferences: Readonly<Record<string, string>>;

  /** Total number of interaction turns recorded with this person. */
  readonly interactionCount: number;

  /** Timestamp of the most recent interaction turn. */
  readonly lastInteraction: Date;

  /**
   * Topics this person has demonstrated interest in or taught to Sylphie.
   * Used for topical personalization and curiosity signal calibration.
   */
  readonly knownTopics: readonly string[];
}

// ---------------------------------------------------------------------------
// STT / TTS
// ---------------------------------------------------------------------------

/**
 * Result of transcribing an audio buffer via the STT service (OpenAI Whisper).
 *
 * confidence is Whisper's word-error-rate-derived score. When below 0.70,
 * the parsed input should note low confidence so downstream services can
 * treat the text as uncertain.
 */
export interface TranscriptionResult {
  /** Transcribed text from the audio buffer. */
  readonly text: string;

  /**
   * Transcription confidence in [0.0, 1.0].
   * Below 0.70: treat the text as uncertain; log for review.
   */
  readonly confidence: number;

  /**
   * BCP-47 language code detected by Whisper (e.g. 'en', 'fr').
   * Used for TTS voice selection and logging.
   */
  readonly languageCode: string;

  /** Duration of the audio buffer in milliseconds. */
  readonly durationMs: number;
}

/**
 * TTS synthesis options passed to ITtsService.synthesize().
 *
 * All fields are optional — defaults are configured in AppConfig.
 */
export interface TtsOptions {
  /**
   * Voice identifier for the TTS provider.
   * OpenAI TTS voices: 'alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'.
   * Defaults to AppConfig.tts.defaultVoice when absent.
   */
  readonly voice?: string;

  /**
   * Speech rate multiplier. Range [0.25, 4.0] per OpenAI TTS API.
   * Defaults to 1.0.
   */
  readonly speed?: number;

  /**
   * Audio format for the synthesized buffer.
   * Supported: 'mp3', 'opus', 'aac', 'flac'.
   * Defaults to 'mp3'.
   */
  readonly format?: 'mp3' | 'opus' | 'aac' | 'flac';
}

/**
 * Result of a TTS synthesis call.
 *
 * audioBuffer is the raw audio bytes in the requested format.
 * durationMs is the approximate playback duration for pacing and latency
 * accounting.
 */
export interface SynthesisResult {
  /** Raw audio bytes in the format declared by TtsOptions.format (default 'mp3'). */
  readonly audioBuffer: Buffer;

  /** Approximate playback duration in milliseconds. */
  readonly durationMs: number;

  /** The format of the audio buffer. Matches TtsOptions.format or the default. */
  readonly format: 'mp3' | 'opus' | 'aac' | 'flac';
}

// ---------------------------------------------------------------------------
// Service Interfaces
// ---------------------------------------------------------------------------

/**
 * Main facade for the Communication subsystem.
 *
 * The primary entry point for input handling and response delivery. Decision
 * Making calls generateResponse() or initiateComment() for output; the
 * external gateway calls handleGuardianInput() for input handling.
 *
 * CANON §Subsystem 2: Communication is responsible for input parsing, context
 * assembly, LLM invocation, Theater Prohibition checking, and output delivery.
 * It does NOT decide what to say — that is Decision Making's responsibility.
 */
export interface ICommunicationService {
  /**
   * Handle raw input from the guardian: parse, optionally generate a response,
   * and emit all relevant TimescaleDB events.
   *
   * Processing pipeline:
   * 1. Emit INPUT_RECEIVED event.
   * 2. Transcribe audio if voiceBuffer is present (STT).
   * 3. Parse input via IInputParserService.
   * 4. Emit INPUT_PARSED event.
   * 5. If intent warrants a response, call generateResponse().
   * 6. Persist GUARDIAN_CONFIRMATION or GUARDIAN_CORRECTION if applicable.
   * 7. Return CommunicationResult with all event IDs.
   *
   * @param input - Raw guardian input, typed or transcribed.
   * @returns Structured result including parse and event correlation IDs.
   * @throws CommunicationException if parsing or generation fails fatally.
   */
  handleGuardianInput(input: GuardianInput): Promise<CommunicationResult>;

  /**
   * Generate a response for a Decision-Making-dispatched ActionIntent.
   *
   * Assembles LLM context from drive state, episodic memory, and WKG context,
   * invokes the LLM, validates via TheaterValidator, then emits
   * RESPONSE_GENERATED and RESPONSE_DELIVERED events.
   *
   * Type 2 cost (latencyMs, tokensUsed) MUST be reported to the Drive Engine
   * as SoftwareMetricsPayload after the call. This is mandatory — see CANON
   * §Dual-Process Cognition (Type 2 must always carry explicit cost).
   *
   * @param intent - The action intent from Decision Making.
   * @returns The validated generated response ready for output delivery.
   * @throws CommunicationException if LLM is unavailable or generation fails.
   */
  generateResponse(intent: ActionIntent): Promise<GeneratedResponse>;

  /**
   * Attempt to generate a spontaneous comment driven by current drive state.
   *
   * Called by the Drive Engine opportunity detector when Social, Curiosity,
   * or Boredom pressure warrants an unprompted comment. Returns null when
   * the Theater Prohibition validator determines no authentic comment can be
   * produced (Shrug Imperative, Standard 4).
   *
   * When non-null, the returned response has already passed TheaterValidator
   * and been delivered. The SOCIAL_COMMENT_INITIATED event is emitted.
   *
   * @param driveSnapshot - Current drive state that motivated the comment.
   * @returns A validated response if one can be produced; null otherwise.
   */
  initiateComment(driveSnapshot: DriveSnapshot): Promise<GeneratedResponse | null>;
}

/**
 * Input parsing service — converts raw text into structured ParsedInput.
 *
 * Uses the LLM (Type 2) for intent classification and entity extraction until
 * Type 1 patterns graduate from training data. Graduation requires confidence
 * > 0.80 and MAE < 0.10 over last 10 uses (CANON §Confidence Dynamics).
 *
 * Entity extraction identifies named entities and attempts to resolve them
 * against the WKG. Unresolved entities (wkgNodeId = null) are candidates
 * for entity-extraction learning events.
 */
export interface IInputParserService {
  /**
   * Parse a GuardianInput into structured intent and entity data.
   *
   * @param input - The raw guardian input to parse.
   * @returns Structured parse result with intent, entities, and feedback type.
   * @throws CommunicationException if classification fails and no fallback exists.
   */
  parse(input: GuardianInput): Promise<ParsedInput>;
}

/**
 * Person modeling service — maintains and queries Other KG person models.
 *
 * Reads from and writes to the Grafeo Other KG (one KG per person).
 * The person model is used to calibrate response verbosity, topical
 * references, and communication register.
 *
 * CANON §Architecture: Other KG is completely isolated from Self KG and WKG.
 * No shared edges, no cross-contamination. This service never queries the WKG.
 */
export interface IPersonModelingService {
  /**
   * Retrieve the current person model for a given person ID.
   *
   * Returns null when no model exists for this person (first interaction).
   *
   * @param personId - The Grafeo Other KG person identifier (e.g. 'Person_Jim').
   * @returns The person model summary, or null if no model exists yet.
   */
  getPersonModel(personId: string): Promise<PersonModel | null>;

  /**
   * Update the person model for a given person based on a completed interaction.
   *
   * Called after each successful handleGuardianInput() cycle. Updates
   * communicationPreferences, increments interactionCount, updates
   * lastInteraction, and merges any new topics detected in parsedInput.entities.
   *
   * CANON §Architecture: Writes to the Grafeo Other KG only. Does not touch
   * the WKG or Self KG.
   *
   * @param personId - The person whose model is being updated.
   * @param parsedInput - The structured parse of the most recent input.
   * @param response - The generated response delivered to this person.
   */
  updateFromConversation(
    personId: string,
    parsedInput: ParsedInput,
    response: GeneratedResponse,
  ): Promise<void>;
}

/**
 * Theater Prohibition validator.
 *
 * CANON Immutable Standard 1 (Theater Prohibition): Output must correlate
 * with actual drive state. No performing emotions she doesn't have.
 *
 * validate() inspects the response content for expressed emotional register
 * and compares it against the current drive state. Each expressed drive state
 * is checked against the pressure/relief thresholds:
 *   pressure check threshold: 0.2 — expressing need when drive < 0.2 is a violation.
 *   relief check threshold:   0.3 — expressing relief when drive > 0.3 is a violation.
 *
 * Returns a TheaterValidationResult. CommunicationService must not deliver
 * a response where result.passed is false.
 */
export interface ITheaterValidator {
  /**
   * Validate that a response's expressed emotional register correlates with
   * the current drive state.
   *
   * @param responseContent - The LLM-generated response text to validate.
   * @param driveSnapshot - The drive state at the time of response generation.
   * @returns Validation result with pass/fail, violations, and correlation score.
   */
  validate(
    responseContent: string,
    driveSnapshot: DriveSnapshot,
  ): Promise<TheaterValidationResult>;
}

/**
 * Speech-to-text service — transcribes audio buffers via OpenAI Whisper API.
 *
 * Called early in the handleGuardianInput() pipeline when voiceBuffer is
 * present. The transcription populates GuardianInput.text for all downstream
 * processing. The raw buffer is preserved in the event log for audit.
 */
export interface ISttService {
  /**
   * Transcribe an audio buffer to text using the STT provider.
   *
   * @param audioBuffer - Raw audio bytes (WebM, OGG, WAV, MP3, etc.).
   * @param mimeType - Optional MIME type hint (e.g. 'audio/webm'). When
   *   provided it supplements magic-byte detection for extension selection.
   * @returns Transcription result with text, confidence, language, and duration.
   * @throws CommunicationException if the STT API call fails.
   */
  transcribe(audioBuffer: Buffer, mimeType?: string): Promise<TranscriptionResult>;
}

/**
 * Text-to-speech service — synthesizes text to audio via OpenAI TTS API.
 *
 * Called in the final delivery step of the Communication pipeline after
 * the response has passed TheaterValidator. The synthesized audio is sent
 * to the hardware output layer (speaker or chatbox player).
 */
export interface ITtsService {
  /**
   * Synthesize text to audio using the TTS provider.
   *
   * @param text - The validated response text to synthesize.
   * @param options - Optional TTS configuration (voice, speed, format).
   * @returns Synthesis result with audio buffer, duration, and format.
   * @throws CommunicationException if the TTS API call fails.
   */
  synthesize(text: string, options?: TtsOptions): Promise<SynthesisResult>;
}

// ---------------------------------------------------------------------------
// Communication Events
// ---------------------------------------------------------------------------

/**
 * Event payload emitted for INPUT_RECEIVED (raw input arrival).
 *
 * CANON §Communication: First event in the input handling pipeline.
 * Records whether the input was voice (STT required) or typed.
 */
export interface InputReceivedEvent {
  /** True if the input arrived via voice (STT transcription pending). */
  readonly fromVoice: boolean;

  /** Transcription confidence if fromVoice is true; null otherwise. */
  readonly transcriptionConfidence: number | null;
}

/**
 * Event payload emitted for INPUT_PARSED (structured parse completion).
 *
 * CANON §Communication: Records the parsed intent and extracted entities.
 * Used downstream by Learning and Decision Making to understand what
 * Sylphie heard and how to respond.
 */
export interface InputParsedEvent {
  /** The classified intent type from the parser. */
  readonly intentType: InputIntentType;

  /** Count of entities identified in the input. */
  readonly entityCount: number;

  /** Parser confidence in the intent classification. */
  readonly parseConfidence: number;
}

/**
 * Event payload emitted for RESPONSE_GENERATED (LLM response created).
 *
 * CANON §Communication: Records the response text and theater validation result.
 * Indicates whether the response passed the Theater Prohibition check.
 */
export interface ResponseGeneratedEvent {
  /** Theater validation pass/fail result. */
  readonly theaterPassed: boolean;

  /** Count of violations detected (0 if theaterPassed is true). */
  readonly violationCount: number;

  /** Tokens consumed by this LLM call. */
  readonly tokensUsed: number;

  /** Latency in milliseconds for the LLM call. */
  readonly latencyMs: number;
}

/**
 * Event payload emitted for RESPONSE_DELIVERED (response sent to output).
 *
 * CANON §Communication: Final event indicating the response was committed
 * to output (TTS or chatbox). Only emitted for responses that passed theater
 * validation.
 */
export interface ResponseDeliveredEvent {
  /** Length of the delivered text in characters. */
  readonly textLength: number;

  /** Format of the output (text-only, audio, or both). */
  readonly outputFormat: 'text' | 'audio' | 'both';
}

/**
 * Event payload emitted for SOCIAL_COMMENT_INITIATED (unprompted comment).
 *
 * CANON §Communication: Raised when the drive engine's opportunity detector
 * triggers a spontaneous comment. Records which drives motivated the comment.
 */
export interface SocialCommentInitiatedEvent {
  /** The primary drive that motivated this comment. */
  readonly motivatingDrive: DriveName;

  /** Secondary drives also above threshold (context). */
  readonly contextualDrives: readonly DriveName[];

  /** Whether this was a drive-test comment or genuine. */
  readonly opportunityType: 'genuine_drive_pressure' | 'test_social';
}

// ---------------------------------------------------------------------------
// Response Generation Context
// ---------------------------------------------------------------------------

/**
 * Complete context assembled for LLM response generation.
 *
 * CANON §Communication: Passed to the LLM alongside the ActionIntent.
 * Provides drive state, WKG context, person model, and episodic memory
 * for the LLM to ground its response in Sylphie's actual state and knowledge.
 *
 * This type consolidates all input to response generation so it can be
 * tested, logged, and audited as a unit.
 */
export interface ResponseGenerationContext {
  /** Drive snapshot at generation time. Used by Theater Prohibition validator. */
  readonly driveState: DriveSnapshot;

  /** World Knowledge Graph context for entities mentioned in the action intent. */
  readonly wkgContext: readonly string[];

  /** Simplified person model for the guardian, if available. */
  readonly personModel: PersonModel | null;

  /** Recent episodic memory (summaries, not full records). */
  readonly episodeSummaries: readonly EpisodeSummary[];

  /** Conversation history for coherence grounding. */
  readonly conversationHistory: readonly ConversationMessage[];
}

/**
 * A message in a conversation thread.
 *
 * CANON §Communication: Carries speaker role, content, and timestamp
 * for reconstructing conversation context for the LLM.
 */
export interface ConversationMessage {
  /** Who spoke: Sylphie or the guardian. */
  readonly speaker: 'sylphie' | 'guardian';

  /** The text of the message. */
  readonly content: string;

  /** Wall-clock time the message was sent. */
  readonly timestamp: Date;
}

/**
 * Summary of a recent episode for LLM context.
 *
 * CANON §Communication: Lightweight episode summaries included in LLM context.
 * The Decision Making subsystem stores the full episodic record; Communication
 * receives summaries for response grounding.
 */
export interface EpisodeSummary {
  /** Brief human-readable summary of the episode. */
  readonly summary: string;

  /** Wall-clock time of the episode. */
  readonly timestamp: Date;

  /** Relevance weight in [0.0, 1.0] for episode inclusion decisions. */
  readonly relevanceWeight: number;
}

/**
 * A conversation thread with context about topic and participant.
 *
 * CANON §Communication: Enables multi-turn conversation coherence and topic
 * tracking for person-aware response generation. The person model uses this
 * to refine knowledge about what the guardian cares about.
 */
export interface ConversationThread {
  /** Unique identifier for this conversation thread. */
  readonly threadId: string;

  /** Person ID (guardian or other interlocutor). */
  readonly personId: string;

  /** All messages in this thread, chronological order. */
  readonly messages: readonly ConversationMessage[];

  /** Topic(s) being discussed in this thread. */
  readonly topics: readonly string[];

  /** Wall-clock time the thread started. */
  readonly startedAt: Date;

  /** Wall-clock time of the most recent message. */
  readonly lastMessageAt: Date;
}

// ---------------------------------------------------------------------------
// Cost Tracking for Type 2
// ---------------------------------------------------------------------------

/**
 * Report of cognitive effort expended in a Type 2 deliberation call.
 *
 * CANON §Dual-Process Cognition: Type 2 must always carry an explicit cost.
 * This report is sent to the Drive Engine after every LLM call so the
 * CognitiveAwareness drive can apply pressure proportional to effort spent.
 *
 * latencyMs and token_count together determine the cost pressure on
 * CognitiveAwareness. This is the primary mechanism that creates evolutionary
 * pressure for Type 1 graduation.
 */
export interface LlmCostReport {
  /** Latency in milliseconds for the LLM API call. */
  readonly latency_ms: number;

  /** Total tokens consumed (prompt + completion). */
  readonly token_count: number;

  /** Estimated USD cost of this call for budget tracking. */
  readonly cost_usd: number;

  /** Session ID for correlating this cost with other events. */
  readonly sessionId: string;

  /** Wall-clock time this cost report was created. */
  readonly timestamp: Date;
}

// ---------------------------------------------------------------------------
// Drive Narrative Construction
// ---------------------------------------------------------------------------

/**
 * Raw material for constructing a drive narrative for LLM system prompt.
 *
 * CANON §Theater Prohibition (Standard 1): The LLM must know Sylphie's
 * actual drive state to speak authentically. A DriveNarrative packages
 * high-pressure drives and their context so the LLM can incorporate
 * this motivation into the response voice.
 *
 * Example: if CognitiveAwareness is 0.7 and Curiosity is 0.5, the LLM
 * receives a narrative like "Sylphie is eager to understand new things
 * and feels some mental strain from recent deliberation."
 */
export interface DriveNarrative {
  /** The specific drive in question. */
  readonly drive: DriveName;

  /** Current pressure value in [-10.0, 1.0]. */
  readonly pressure: number;

  /**
   * Human-readable descriptor for this pressure level.
   * Example: "high curiosity," "relief from social interaction," "anxiety surge."
   */
  readonly narrative: string;

  /** Whether this drive is above the threshold to influence response tone. */
  readonly isAboveThreshold: boolean;
}

/**
 * Assembled narrative describing Sylphie's current motivational state.
 *
 * CANON §Theater Prohibition: Injected into the LLM system prompt so
 * the LLM's response reflects Sylphie's actual emotional register.
 * Contains descriptions of all drives above threshold plus any other
 * contextually relevant drives.
 */
export interface MotivationalNarrative {
  /** All drive narratives, ordered by pressure (highest first). */
  readonly drives: readonly DriveNarrative[];

  /** High-level summary for the system prompt. */
  readonly summary: string;

  /** Total unmet pressure (sum of positive drive values). */
  readonly totalPressure: number;
}
